import { randomUUID } from "node:crypto";

import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@generic-ai/agent";
import type { AssistantMessage, Model, RetryPolicy, ThinkingLevel } from "@generic-ai/ai";
import {
  type CompactionSettings,
  compactIfNeeded,
  convertToLlm,
  DEFAULT_RETRY_POLICY,
  persistAgentMessages,
  restoreAgentContext,
  runWithRetry,
  SessionManager,
} from "@generic-ai/session";
import type { RunEnvelope, RunEnvelopeMode } from "@generic-ai/sdk";

import {
  type CanonicalEvent,
  type CanonicalEventStream,
  createCanonicalEventStream,
  createPluginEvent,
} from "../events/index.js";
import { createRunEnvelope } from "../run-envelope/index.js";
import type { UsageAttribution, UsageMeter } from "../usage/index.js";
import {
  type CapabilityPiSessionEventContext,
  type PiCapabilityBindings,
  type PiCapabilitySessionLifecycleHooks,
  type PiCapabilityToolRegistry,
  resolveCapabilityPiToolRegistry,
} from "./capability-runtime.js";
import { createNativeStopTool } from "./native.js";
import {
  type AgentTurnMode,
  STOP_AND_RESPOND_TOOL_NAME,
  type StopAndRespondState,
  runStopToolLoop,
} from "./stop-tool-loop.js";

const NATIVE_RUNTIME_EVENT_PLUGIN_ID = "generic-ai-runtime";

/**
 * Options for one capability-bound agent session on the native runtime. The shape mirrors
 * `RunCapabilityPiAgentSessionOptions` so the harness can run either backend with the same
 * policy, hook, and event plumbing; the pi-specific auth, registry, and session-manager inputs
 * are replaced by a resolved `model`.
 */
export interface RunCapabilityNativeAgentSessionOptions {
  readonly cwd: string;
  readonly model: Model;
  readonly capabilities: PiCapabilityBindings;
  readonly prompt: string;
  /** Base system prompt. Tool guidance, skills, and the working directory are appended. */
  readonly systemPrompt?: string;
  readonly apiKey?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly streamFn?: StreamFn;
  readonly signal?: AbortSignal;
  readonly turnMode?: AgentTurnMode;
  readonly maxTurns?: number;
  readonly runId?: string;
  readonly rootScopeId?: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly rootAgentId?: string;
  readonly mode?: RunEnvelopeMode;
  readonly eventStream?: CanonicalEventStream;
  readonly onSessionReady?: (context: CapabilityPiSessionEventContext) => Promise<void> | void;
  readonly lifecycleHooks?: PiCapabilitySessionLifecycleHooks;
  /**
   * Where the conversation is recorded. Pass a file-backed manager (`SessionManager.create`,
   * `SessionManager.open`) to persist and resume it; an existing session's context is loaded before
   * the prompt. Defaults to an in-memory session.
   */
  readonly sessionManager?: SessionManager;
  /** Auto-compaction before each prompt when the context nears the model's window. `false` turns it off. */
  readonly compaction?: Partial<CompactionSettings> | false;
  /** Retry on transient provider errors. Defaults to three retries with exponential backoff; `false` turns it off. */
  readonly retry?: RetryPolicy | false;
  /**
   * Meter this session's model responses (usually one meter shared by every session of a run). The
   * meter emits `usage.recorded` events, and when it reaches a cap its signal aborts this session
   * like a caller abort, with a `UsageBudgetExceededError` as the reason. A budget abort is never
   * retried.
   */
  readonly usageMeter?: UsageMeter;
  /** Role, agent, and goal labels for this session's usage. The agent defaults to the session id. */
  readonly usageAttribution?: UsageAttribution;
}

export interface RunCapabilityNativeAgentSessionResult {
  readonly sessionId: string;
  /** The session's JSONL file, when the session manager persists to disk. */
  readonly sessionFile?: string;
  readonly model: Model;
  readonly messages: readonly unknown[];
  readonly toolRegistry: PiCapabilityToolRegistry;
  readonly envelope: RunEnvelope;
  readonly eventStream: CanonicalEventStream;
  readonly events: readonly CanonicalEvent[];
  readonly outputText?: string;
  readonly terminalStatus?: StopAndRespondState["status"];
  readonly failureMessage?: string;
}

const DEFAULT_NATIVE_SYSTEM_PROMPT =
  "You are a capable autonomous agent. Work carefully, use the available tools to inspect and change the workspace, and verify your work before you report it.";

type PromptedTool = {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

/** Assemble the system prompt from the base prompt, tool snippets and guidelines, and skills. */
export function buildNativeSystemPrompt(input: {
  readonly base?: string;
  readonly cwd: string;
  readonly tools: readonly PromptedTool[];
  readonly skillsPrompt?: string;
}): string {
  const sections = [input.base?.trim() || DEFAULT_NATIVE_SYSTEM_PROMPT];
  const snippets = input.tools
    .filter((tool) => typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0)
    .map((tool) => `- ${tool.name}: ${tool.promptSnippet}`);
  if (snippets.length > 0) {
    sections.push(["Available tools:", ...snippets].join("\n"));
  }
  const guidelines = input.tools.flatMap((tool) => tool.promptGuidelines ?? []);
  if (guidelines.length > 0) {
    sections.push(["Guidelines:", ...guidelines.map((line) => `- ${line}`)].join("\n"));
  }
  if (input.skillsPrompt !== undefined && input.skillsPrompt.trim().length > 0) {
    sections.push(input.skillsPrompt.trim());
  }
  sections.push(`Current working directory: ${input.cwd}`);
  return sections.join("\n\n");
}

function serializeNativeEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "message_start":
    case "message_end":
      return {
        type: event.type,
        role: "role" in event.message ? event.message.role : "custom",
      };
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      return {
        type: event.type,
        assistantMessageEventType: assistantEvent.type,
        ...("delta" in assistantEvent && typeof assistantEvent.delta === "string"
          ? { delta: assistantEvent.delta }
          : {}),
      };
    }
    case "tool_execution_start":
    case "tool_execution_update":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "turn_end":
      return { type: event.type, toolResultCount: event.toolResults.length };
    case "agent_end":
      return { type: event.type, messageCount: event.messages.length };
    default:
      return { type: event.type };
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopToolFailureMessage(
  status: StopAndRespondState["status"] | undefined,
): string | undefined {
  return status === "blocked" || status === "failed"
    ? `Agent stopped with terminal status "${status}".`
    : undefined;
}

function latestAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (message?.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Run one capability-bound agent session on the native runtime and record it on the canonical
 * event stream exactly like the pi session runner: `run.created`, `session.created`,
 * `run.started`, `session.started`, one plugin event per agent event, then the terminal session
 * and run events.
 */
export async function runCapabilityNativeAgentSession(
  options: RunCapabilityNativeAgentSessionOptions,
): Promise<RunCapabilityNativeAgentSessionResult> {
  const turnMode = options.turnMode ?? "stop-tool-loop";
  const stopState: StopAndRespondState = { stopped: false };
  const toolRegistry = await resolveCapabilityPiToolRegistry(options.capabilities);
  const capabilityTools = [
    ...toolRegistry.tools,
    ...toolRegistry.customTools,
  ] as unknown as AgentTool[];
  const tools =
    turnMode === "single-turn"
      ? capabilityTools
      : [...capabilityTools, createNativeStopTool(stopState)];
  const systemPrompt = buildNativeSystemPrompt({
    ...(options.systemPrompt === undefined ? {} : { base: options.systemPrompt }),
    cwd: options.cwd,
    tools: tools as unknown as PromptedTool[],
    ...(toolRegistry.skillSnapshot === undefined
      ? {}
      : { skillsPrompt: toolRegistry.skillSnapshot.prompt }),
  });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(options.cwd);
  const sessionId = sessionManager.getSessionId();
  const apiKey = options.apiKey?.trim();
  const agent = new Agent({
    initialState: {
      model: options.model,
      systemPrompt,
      tools,
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
    sessionId,
    convertToLlm,
    ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { getApiKey: () => apiKey }),
  });

  restoreAgentContext(agent, sessionManager);
  const stopPersisting = persistAgentMessages(agent, sessionManager);
  const retryPolicy = options.retry === false ? undefined : (options.retry ?? DEFAULT_RETRY_POLICY);

  const runId = options.runId ?? randomUUID();
  const scopeId = options.rootScopeId ?? "scope/root";
  const eventStream = options.eventStream ?? createCanonicalEventStream({});
  const createdAt = new Date().toISOString();
  const startedAt = new Date().toISOString();
  const eventContext = {
    scopeId,
    runId,
    rootSessionId: options.rootSessionId ?? sessionId,
    sessionId,
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
  } satisfies CapabilityPiSessionEventContext;
  const toolNames = tools.map((tool) => tool.name);
  const signal = mergeAbortSignals(options.signal, options.usageMeter?.signal);
  const unmeter = options.usageMeter?.bindAgent(agent, {
    ...eventContext,
    ...options.usageAttribution,
  });

  await eventStream.emit({
    ...eventContext,
    name: "run.created",
    data: { toolNames, model: `${options.model.provider}/${options.model.id}` },
  });
  await eventStream.emit({ ...eventContext, name: "session.created", data: { sessionId } });
  await options.onSessionReady?.(eventContext);
  await options.lifecycleHooks?.onSessionStart?.(eventContext);
  await eventStream.emit({ ...eventContext, name: "run.started" });
  await eventStream.emit({ ...eventContext, name: "session.started" });

  let forwarder = Promise.resolve();
  const unsubscribe = agent.subscribe((event) => {
    forwarder = forwarder
      .then(() =>
        eventStream.emit(
          createPluginEvent(NATIVE_RUNTIME_EVENT_PLUGIN_ID, `native.${event.type}`, {
            ...eventContext,
            origin: { subsystem: "native-session" },
            data: serializeNativeEvent(event),
          }),
        ),
      )
      .catch(() => undefined)
      .then(() => undefined);
  });
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort, { once: true });

  const emitRuntimeEvent = (type: string, data: Record<string, unknown>) =>
    eventStream.emit(
      createPluginEvent(NATIVE_RUNTIME_EVENT_PLUGIN_ID, `native.${type}`, {
        ...eventContext,
        origin: { subsystem: "native-session" },
        data: { type, ...data },
      }),
    );

  const runPrompt = async (text: string) => {
    if (options.compaction !== false) {
      const compaction = await compactIfNeeded(agent, sessionManager, {
        model: options.model,
        settings: options.compaction,
        apiKey,
        streamFn: options.streamFn,
        signal,
        retry: retryPolicy,
      });
      if (compaction !== undefined) {
        await emitRuntimeEvent("compaction", {
          tokensBefore: compaction.tokensBefore,
          firstKeptEntryId: compaction.firstKeptEntryId,
        });
      }
    }
    await runWithRetry(agent, () => agent.prompt(text), {
      policy: retryPolicy ?? { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      signal,
      onRetry: async (notice) => {
        await emitRuntimeEvent("retry", {
          attempt: notice.attempt,
          maxRetries: notice.maxRetries,
          delayMs: notice.delayMs,
          errorMessage: notice.errorMessage,
        });
      },
    });
    const last = latestAssistant(agent.state.messages);
    if (signal?.aborted || last?.stopReason === "aborted") {
      throw signal?.reason instanceof Error
        ? signal.reason
        : new Error("Native session run was aborted.");
    }
    if (agent.state.errorMessage !== undefined && !stopState.stopped) {
      throw new Error(agent.state.errorMessage);
    }
  };

  const finish = async (input: {
    readonly failureMessage?: string;
    readonly outputText?: string;
    readonly terminalStatus?: StopAndRespondState["status"];
  }): Promise<RunCapabilityNativeAgentSessionResult> => {
    unsubscribe();
    unmeter?.();
    stopPersisting();
    signal?.removeEventListener("abort", abort);
    await forwarder;
    const messageCount = agent.state.messages.length;
    const failed = input.failureMessage !== undefined;
    const data = failed
      ? {
          error: input.failureMessage,
          messageCount,
          ...(input.terminalStatus === undefined ? {} : { terminalStatus: input.terminalStatus }),
        }
      : {
          messageCount,
          ...(input.terminalStatus === undefined ? {} : { terminalStatus: input.terminalStatus }),
        };
    await eventStream.emit({
      ...eventContext,
      name: failed ? "session.failed" : "session.completed",
      data,
    });
    await eventStream.emit({
      ...eventContext,
      name: failed ? "run.failed" : "run.completed",
      data,
    });
    const events = eventStream.snapshot();
    const lastSequence = events.at(-1)?.sequence;
    const sessionFile = sessionManager.getSessionFile();
    return Object.freeze({
      sessionId,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      model: options.model,
      messages: Object.freeze([...agent.state.messages]),
      toolRegistry,
      eventStream,
      events,
      ...(input.outputText === undefined ? {} : { outputText: input.outputText }),
      ...(input.terminalStatus === undefined ? {} : { terminalStatus: input.terminalStatus }),
      ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
      envelope: createRunEnvelope({
        runId,
        rootScopeId: scopeId,
        ...(options.rootAgentId === undefined ? {} : { rootAgentId: options.rootAgentId }),
        mode: options.mode ?? "sync",
        status: failed ? "failed" : "succeeded",
        timestamps: { createdAt, startedAt, completedAt: new Date().toISOString() },
        eventStream: {
          kind: "event-stream-reference",
          streamId: runId,
          ...(lastSequence === undefined ? {} : { sequence: lastSequence }),
        },
      }),
    });
  };

  try {
    const prompt =
      (await options.lifecycleHooks?.onUserPromptSubmit(eventContext, options.prompt)) ??
      options.prompt;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Native session run was aborted before prompt dispatch.");
    }
    if (turnMode === "single-turn") {
      await runPrompt(prompt);
      await options.lifecycleHooks?.onStop?.(eventContext);
      const outputText = assistantText(latestAssistant(agent.state.messages));
      return await finish(outputText === undefined ? {} : { outputText });
    }
    const loop = await runStopToolLoop({
      prompt,
      state: stopState,
      maxTurns: options.maxTurns,
      runPrompt: (text) => runPrompt(text),
    });
    if (!loop.stopped || loop.outputText === undefined) {
      throw new Error(
        `${STOP_AND_RESPOND_TOOL_NAME} was not called after ${loop.turnCount} turn(s).`,
      );
    }
    await options.lifecycleHooks?.onStop?.(eventContext);
    const failureMessage = stopToolFailureMessage(loop.status);
    return await finish({
      outputText: loop.outputText,
      ...(loop.status === undefined ? {} : { terminalStatus: loop.status }),
      ...(failureMessage === undefined ? {} : { failureMessage }),
    });
  } catch (error) {
    return finish({ failureMessage: toErrorMessage(error) });
  }
}

/** One signal that aborts when any of the given signals does, keeping the first abort reason. */
function mergeAbortSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) {
    return present[0];
  }
  return AbortSignal.any(present);
}
