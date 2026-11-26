import { randomUUID } from "node:crypto";

import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@generic-ai/agent";
import type { AssistantMessage, Model, RetryPolicy, ThinkingLevel } from "@generic-ai/ai";
import {
  discoverAndLoadExtensions,
  type ExtensionFactory,
  type ExtensionRunner,
} from "@generic-ai/extensions";
import {
  expandPromptTemplate,
  expandSkillCommand,
  type PromptTemplate,
  type Skill,
} from "@generic-ai/resources";
import {
  type CompactionSettings,
  compactIfNeeded,
  compactNow,
  convertToLlm,
  DEFAULT_RETRY_POLICY,
  persistAgentMessages,
  restoreAgentContext,
  runWithRetry,
  SessionManager,
} from "@generic-ai/session";
import {
  formatRefinementNotice,
  parseRefineCommand,
  type RefinementResult,
} from "@generic-ai/continual";
import {
  type AutonomousStatus,
  autonomousStatus,
  type GoalState,
  type ScheduledJob,
} from "@generic-ai/autonomy";
import {
  goalTraceFromCanonicalEvents,
  type RunEnvelope,
  type RunEnvelopeMode,
} from "@generic-ai/sdk";
import {
  type AgentNode,
  createAgentChildSessionFactory,
  createSubagentRoot,
  createSubagentTools,
  type SubagentEvent,
} from "@generic-ai/subagents";
import {
  createToolBatchTool,
  type OffloadOptions,
  type ToolBatchOptions,
  withOffload,
} from "@generic-ai/tools";

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
  createSessionLongRun,
  type NativeSessionAutonomous,
  type NativeSessionGoal,
} from "./native-long-run.js";
import {
  createSessionContinual,
  type NativeSessionContinual,
  type RefinementSource,
} from "./native-continual.js";
import { createSessionSchedules, type NativeSessionSchedules } from "./native-schedules.js";
import {
  createScriptHarvest,
  type HarvestedScript,
  type NativeSessionHarvest,
} from "./script-harvest.js";
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
  /**
   * Prompt templates. A prompt that starts with `/name args` is replaced by template `name` with
   * its `$1`, `$@` and `${@:N}` placeholders filled from the arguments.
   */
  readonly promptTemplates?: readonly PromptTemplate[];
  /** Extensions to load for this session (see `@generic-ai/extensions`). */
  readonly extensions?: NativeSessionExtensions;
  /**
   * Let the agent spawn subagents and message them (see `@generic-ai/subagents`). Children run in
   * this process and are stopped when the session ends.
   */
  readonly subagents?: NativeSessionSubagents | boolean;
  /**
   * Keep the session working toward a persistent thread goal (see `@generic-ai/autonomy`). `true`
   * gives the agent the goal tools without starting a goal. The goal is saved in the session, so a
   * resumed session continues it.
   */
  readonly goal?: NativeSessionGoal | boolean;
  /**
   * Autonomous mode: continue with no human input until the quality gates pass or a limit is
   * reached. In stop-tool mode a "completed" stop is checked against the gates and sent back with
   * the failure when they fail.
   */
  readonly autonomous?: NativeSessionAutonomous | boolean;
  /**
   * Scheduled prompts and a heartbeat (see `docs/schedules.md`). `true` gives the agent the schedule
   * tools. Jobs are saved in the session; due jobs reach the agent while it works, and a
   * `service` runs the ones that come due after the session ends.
   */
  readonly schedules?: NativeSessionSchedules | boolean;
  /**
   * Offload long tool results: a result longer than `maxChars` (default 16000 characters) is saved
   * to a file and the model gets a preview and the path (see `docs/offloading.md`). On by default;
   * `false` turns it off.
   */
  readonly offload?: OffloadOptions | false;
  /** Give the agent `tool_batch`, which runs several independent tool calls in one step. */
  readonly toolBatch?: ToolBatchOptions | boolean;
  /**
   * Save the scripts the agent writes when the run passes its goal's validators, so they can be
   * reused or promoted into skills (`promoteScriptToSkill`).
   */
  readonly harvest?: NativeSessionHarvest;
  /**
   * The continual harness (see `docs/continual-harness.md`): the agent refines supplemental
   * prompt notes, memories, skills and subagent specs from evidence with the `refine` tool or a
   * `/refine` prompt, and they are shown in its system prompt from then on.
   */
  readonly continual?: NativeSessionContinual;
}

export type { NativeSessionContinual } from "./native-continual.js";
export type { NativeSessionAutonomous, NativeSessionGoal } from "./native-long-run.js";

export interface NativeSessionSubagents {
  /** Deepest subagent level; the session itself is depth 0. Defaults to 3. */
  readonly maxDepth?: number;
  /** Running children one agent may have at once. Defaults to 8. */
  readonly maxRunningChildren?: number;
  /** Resolve the model a spawn asks for. Without it, children can only use the session's model. */
  readonly resolveModel?: (reference: string) => Model | undefined;
  /** Base system prompt for children. Defaults to the subagent prompt from `@generic-ai/subagents`. */
  readonly systemPrompt?: string;
  /** Give children the session's capability tools. Defaults to true. */
  readonly inheritTools?: boolean;
  /**
   * API key for a child's provider. Defaults to the session's `apiKey` for the session's provider,
   * and to the provider's own environment variable otherwise.
   */
  readonly getApiKey?: (provider: string) => string | undefined;
}

export interface NativeSessionExtensions {
  /** Extension files or directories. Relative paths resolve against `cwd`. */
  readonly paths?: readonly string[];
  /** Extensions given as factories. */
  readonly factories?: readonly ExtensionFactory[];
  /**
   * Also load `<cwd>/.generic-ai/extensions` and, when `agentDir` is set, `<agentDir>/extensions`.
   * Off by default, because extensions run with the process's full permissions.
   */
  readonly discover?: boolean;
  readonly agentDir?: string;
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
  /** The thread goal's final state, when the session had one. */
  readonly goal?: GoalState;
  /** Autonomous mode's counters and gate results, when it was on. */
  readonly autonomous?: AutonomousStatus;
  /** The session's active and paused scheduled jobs when it ended, when it has schedules. */
  readonly schedules?: readonly ScheduledJob[];
  /** Scripts saved because the run passed its goal's validators. */
  readonly harvestedScripts?: readonly HarvestedScript[];
  /** Continual harness refinements made during the session. */
  readonly refinements?: readonly RefinementResult[];
}

const DEFAULT_NATIVE_SYSTEM_PROMPT =
  "You are a capable autonomous agent. Work carefully, use the available tools to inspect and change the workspace, and verify your work before you report it.";

type PromptedTool = {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

async function loadSessionExtensions(
  options: RunCapabilityNativeAgentSessionOptions,
  emitRuntimeEvent: (type: string, data: Record<string, unknown>) => Promise<unknown>,
): Promise<ExtensionRunner | undefined> {
  const config = options.extensions;
  if (
    config === undefined ||
    (config.discover !== true &&
      (config.paths ?? []).length === 0 &&
      (config.factories ?? []).length === 0)
  ) {
    return undefined;
  }
  const loaded = await discoverAndLoadExtensions({
    cwd: options.cwd,
    includeDefaults: config.discover === true,
    ...(config.agentDir === undefined ? {} : { agentDir: config.agentDir }),
    ...(config.paths === undefined ? {} : { paths: config.paths }),
    ...(config.factories === undefined ? {} : { factories: config.factories }),
  });
  for (const error of loaded.errors) {
    await emitRuntimeEvent("extension_error", {
      extensionPath: error.path,
      event: "load",
      error: error.error,
    });
  }
  loaded.runner.onError((error) => {
    void emitRuntimeEvent("extension_error", { ...error });
  });
  await emitRuntimeEvent("extensions_loaded", {
    extensions: loaded.extensions.map((extension) => extension.path),
    tools: loaded.runner.getTools().map((tool) => tool.name),
    commands: loaded.runner.getCommands().map((command) => command.invocationName),
  });
  return loaded.runner;
}

function createSessionSubagentRoot(
  options: RunCapabilityNativeAgentSessionOptions,
  input: {
    readonly sessionId: string;
    readonly capabilityTools: readonly AgentTool[];
    readonly apiKey?: string;
    readonly onEvent: (event: SubagentEvent) => void;
  },
): AgentNode | undefined {
  if (options.subagents === undefined || options.subagents === false) {
    return undefined;
  }
  const config: NativeSessionSubagents = options.subagents === true ? {} : options.subagents;
  const apiKey = input.apiKey;
  const getApiKey =
    config.getApiKey ??
    ((provider: string) => (provider === options.model.provider ? apiKey : undefined));
  const baseTools = config.inheritTools === false ? [] : input.capabilityTools;
  return createSubagentRoot({
    id: input.sessionId,
    name: options.rootAgentId ?? "main",
    ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
    ...(config.maxRunningChildren === undefined
      ? {}
      : { maxRunningChildren: config.maxRunningChildren }),
    onEvent: input.onEvent,
    factory: createAgentChildSessionFactory({
      model: options.model,
      tools: baseTools,
      convertToLlm,
      ...(config.resolveModel === undefined ? {} : { resolveModel: config.resolveModel }),
      ...(config.systemPrompt === undefined
        ? {}
        : {
            systemPrompt: (request) =>
              `${config.systemPrompt}\n\nYou are the subagent "${request.name}". Current working directory: ${
                request.cwd ?? options.cwd
              }`,
          }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
      getApiKey,
    }),
  });
}

/**
 * Expand a `/skill:name args` command into the skill's instructions, or a `/template args` command
 * into its prompt template. Any other text is returned unchanged.
 */
export function expandPrompt(
  text: string,
  skills: readonly Skill[],
  templates: readonly PromptTemplate[],
): string {
  const expanded = expandSkillCommand(text, skills);
  return expanded === text ? expandPromptTemplate(text, [...templates]) : expanded;
}

/** Assemble the system prompt from the base prompt, tool snippets and guidelines, and skills. */
export function buildNativeSystemPrompt(input: {
  readonly base?: string;
  readonly cwd: string;
  readonly tools: readonly PromptedTool[];
  readonly skillsPrompt?: string;
  readonly continualPrompt?: string;
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
  if (input.continualPrompt !== undefined && input.continualPrompt.trim().length > 0) {
    sections.push(input.continualPrompt.trim());
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
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(options.cwd);
  const sessionId = sessionManager.getSessionId();
  const apiKey = options.apiKey?.trim();
  let emitSubagentEvent: (event: SubagentEvent) => void = () => {};
  const subagentRoot = createSessionSubagentRoot(options, {
    sessionId,
    capabilityTools,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    onEvent: (event) => emitSubagentEvent(event),
  });
  let passedValidation: string | undefined;
  const longRun = createSessionLongRun({
    cwd: options.cwd,
    sessionManager,
    goal: options.goal,
    autonomous: options.autonomous,
    evidence: () => {
      const outputText = stopState.response ?? assistantText(latestAssistant(agent.state.messages));
      return {
        ...(outputText === undefined ? {} : { outputText }),
        trace: goalTraceFromCanonicalEvents(eventStream.snapshot()),
      };
    },
    signal: options.signal,
    onValidation: async (report) => {
      passedValidation = report.complete ? report.goalId : undefined;
      await emitRuntimeEvent("goal_validation", {
        goalId: report.goalId,
        status: report.status,
        summary: report.summary,
      });
    },
  });
  const schedules = createSessionSchedules({
    sessionManager,
    schedules: options.schedules,
    onFire: (job, delivery) => {
      void emitRuntimeEvent("schedule_fired", {
        jobId: job.id,
        source: job.source,
        delivery,
      });
    },
  });
  const scheduleOptions = typeof options.schedules === "object" ? options.schedules : undefined;
  const refinements: RefinementResult[] = [];
  const continual = await createSessionContinual({
    options: options.continual,
    sessionManager,
    model: options.model,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onRefined: async (result, source) => {
      refinements.push(result);
      agent.state.systemPrompt = composeSystemPrompt();
      await emitRuntimeEvent("harness_refined", {
        refinementId: result.id,
        source,
        scope: result.scope ?? "local",
        summary: result.summary,
        applied: result.appliedEdits.filter((edit) => edit.applied).length,
        failed: result.appliedEdits.filter((edit) => !edit.applied).length,
        ...(result.rollbackOf === undefined ? {} : { rollbackOf: result.rollbackOf }),
      });
    },
    onError: async (error, source: RefinementSource) => {
      await emitRuntimeEvent("harness_refine_failed", { source, error: toErrorMessage(error) });
    },
    onUsage: async (message, purpose) => {
      await options.usageMeter?.record(
        { ...eventContext, ...options.usageAttribution },
        { provider: message.provider, model: message.model, usage: message.usage, purpose },
      );
    },
  });
  const userOffload = options.offload === false ? undefined : (options.offload ?? {});
  const offload: OffloadOptions | undefined =
    userOffload === undefined
      ? undefined
      : {
          ...userOffload,
          onOffload: (event) => {
            userOffload.onOffload?.(event);
            void emitRuntimeEvent("tool_result_offloaded", { ...event });
          },
        };
  const offloaded = (tool: AgentTool): AgentTool =>
    offload === undefined ? tool : withOffload(tool, offload);
  const tools: AgentTool[] = [
    ...capabilityTools,
    ...(subagentRoot === undefined ? [] : (createSubagentTools(subagentRoot) as AgentTool[])),
    ...(longRun?.tools ?? []),
    ...(schedules?.tools ?? []),
    ...(continual?.tools ?? []),
    ...(turnMode === "single-turn" ? [] : [createNativeStopTool(stopState)]),
  ].map(offloaded);
  if (options.toolBatch !== undefined && options.toolBatch !== false) {
    const batchOptions = options.toolBatch === true ? {} : options.toolBatch;
    tools.push(
      offloaded(
        createToolBatchTool(() => tools, {
          ...batchOptions,
          // Calls that end or decide the run stay single calls the loop sees.
          exclude: [
            ...(batchOptions.exclude ?? []),
            STOP_AND_RESPOND_TOOL_NAME,
            "complete_goal",
            "create_goal",
          ],
        }),
      ),
    );
  }
  const harvest =
    options.harvest === undefined
      ? undefined
      : createScriptHarvest({ cwd: options.cwd, options: options.harvest });
  const composeSystemPrompt = () =>
    buildNativeSystemPrompt({
      ...(options.systemPrompt === undefined ? {} : { base: options.systemPrompt }),
      cwd: options.cwd,
      tools: tools as unknown as PromptedTool[],
      ...(toolRegistry.skillSnapshot === undefined
        ? {}
        : { skillsPrompt: toolRegistry.skillSnapshot.prompt }),
      ...(continual === undefined
        ? {}
        : { continualPrompt: continual.promptSection(options.prompt) }),
    });
  const systemPrompt = composeSystemPrompt();
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

  emitSubagentEvent = (event) => {
    void emitRuntimeEvent(`subagent_${event.type}`, { ...event });
  };
  const unbindSubagents = subagentRoot?.bindAgent(agent);
  const unbindLongRun = longRun?.bindAgent(agent);
  const unbindHarvest = harvest?.bindAgent(agent);
  const unbindContinual = continual?.bindAgent(agent);
  let compacting = false;
  const runningCommands = new Set<string>();
  const unwatchCommands = agent.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      runningCommands.add(event.toolCallId);
    } else if (event.type === "tool_execution_end") {
      runningCommands.delete(event.toolCallId);
    }
  });
  const unbindSchedules = schedules?.bindAgent(agent, () => ({
    isCompacting: compacting,
    isBashRunning: runningCommands.size > 0,
  }));
  const scheduleSessionFile = sessionManager.getSessionFile();
  const releaseScheduledSession =
    scheduleSessionFile === undefined
      ? undefined
      : scheduleOptions?.service?.markOpen(scheduleSessionFile);

  const extensions = await loadSessionExtensions(options, emitRuntimeEvent);
  const unbindExtensions = extensions?.bindAgent(agent);
  await extensions?.emit({ type: "session_start" });

  const runPrompt = async (text: string) => {
    if (extensions === undefined) {
      await runModelPrompt(text);
      return;
    }
    const outcome = await extensions.runPrompt(text, runModelPrompt);
    if (outcome.kind === "handled") {
      await emitRuntimeEvent("extension_handled", {
        ...(outcome.command === undefined ? {} : { command: outcome.command }),
      });
    }
  };

  const runModelPrompt = async (text: string) => {
    if (options.compaction !== false) {
      compacting = true;
      const compaction = await compactIfNeeded(agent, sessionManager, {
        model: options.model,
        settings: options.compaction,
        apiKey,
        streamFn: options.streamFn,
        signal,
        retry: retryPolicy,
        ...(extensions?.hasHandlers("session_before_compact") === true
          ? {
              beforeCompact: (info: { tokens: number; contextWindow: number }) =>
                extensions.emitBeforeCompact({ type: "session_before_compact", ...info }),
            }
          : {}),
      }).finally(() => {
        compacting = false;
      });
      if (compaction !== undefined) {
        if (compaction.usage !== undefined) {
          await options.usageMeter?.record(
            { ...eventContext, ...options.usageAttribution },
            {
              provider: options.model.provider,
              model: options.model.id,
              usage: compaction.usage,
              purpose: "compaction",
            },
          );
        }
        continual?.markCompacted();
        await emitRuntimeEvent("compaction", {
          tokensBefore: compaction.tokensBefore,
          firstKeptEntryId: compaction.firstKeptEntryId,
        });
        await extensions?.emit({
          type: "session_compact",
          summary: compaction.summary,
          tokensBefore: compaction.tokensBefore,
        });
      }
    }
    if (signal?.aborted) {
      // The compaction's own spend can reach the budget; stop before the next model call.
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Native session run was aborted.");
    }
    await runWithRetry(agent, () => agent.prompt(text), {
      policy: retryPolicy ?? { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      signal,
      contextWindow: options.model.contextWindow,
      ...(options.compaction === false
        ? {}
        : {
            onContextOverflow: async () => {
              compacting = true;
              const compaction = await compactNow(agent, sessionManager, {
                model: options.model,
                settings: options.compaction === false ? undefined : options.compaction,
                apiKey,
                streamFn: options.streamFn,
                signal,
                retry: retryPolicy,
              }).finally(() => {
                compacting = false;
              });
              if (compaction === undefined) {
                return false;
              }
              continual?.markCompacted();
              await emitRuntimeEvent("compaction", {
                tokensBefore: compaction.tokensBefore,
                firstKeptEntryId: compaction.firstKeptEntryId,
                reason: "overflow",
              });
              return true;
            },
          }),
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
    await continual?.afterPrompt(agent);
  };

  const finish = async (input: {
    readonly failureMessage?: string;
    readonly outputText?: string;
    readonly terminalStatus?: StopAndRespondState["status"];
  }): Promise<RunCapabilityNativeAgentSessionResult> => {
    await subagentRoot?.children.shutdown();
    unbindSubagents?.();
    unbindLongRun?.();
    unbindHarvest?.();
    unbindContinual?.();
    let harvestedScripts: HarvestedScript[] | undefined;
    if (
      harvest !== undefined &&
      passedValidation !== undefined &&
      input.failureMessage === undefined
    ) {
      try {
        harvestedScripts = await harvest.harvest({ goalId: passedValidation, runId, sessionId });
        if (harvestedScripts.length > 0) {
          await emitRuntimeEvent("scripts_harvested", {
            goalId: passedValidation,
            scripts: harvestedScripts.map((script) => script.sourcePath),
          });
        }
      } catch (error) {
        await emitRuntimeEvent("script_harvest_failed", { error: toErrorMessage(error) });
      }
    }
    await unbindSchedules?.();
    unwatchCommands();
    releaseScheduledSession?.();
    if (scheduleSessionFile !== undefined && scheduleOptions?.service !== undefined) {
      try {
        await scheduleOptions.service.sync(scheduleSessionFile, sessionManager);
      } catch (error) {
        await emitRuntimeEvent("schedule_sync_failed", { error: toErrorMessage(error) });
      }
    }
    await extensions?.emit({ type: "session_shutdown" });
    unbindExtensions?.();
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
      ...(longRun?.goal === undefined ? {} : { goal: longRun.goal.stateWithCreationElapsed() }),
      ...(longRun?.autonomous === undefined
        ? {}
        : { autonomous: autonomousStatus(longRun.autonomous.state) }),
      ...(schedules === undefined ? {} : { schedules: schedules.book.list() }),
      ...(harvestedScripts === undefined || harvestedScripts.length === 0
        ? {}
        : { harvestedScripts }),
      ...(refinements.length === 0 ? {} : { refinements: [...refinements] }),
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

  /** The prompt for the next long-run turn, or undefined when the goal and autonomous mode stop. */
  const nextLongRunStep = async (): Promise<string | undefined> => {
    if (longRun === undefined) {
      return undefined;
    }
    const next = await longRun.controller.afterTurn(latestAssistant(agent.state.messages), signal);
    if (next.kind === "continue") {
      await emitRuntimeEvent("long_run_continuation", { source: next.source });
      return next.text;
    }
    await emitRuntimeEvent("long_run_stopped", {
      ...(next.goal === undefined
        ? {}
        : { goalStatus: next.goal.status, goalReason: next.goal.lastReason }),
      ...(next.autonomous === undefined ? {} : { autonomousStop: next.autonomous.reason }),
    });
    return undefined;
  };

  /** Delivers scheduled prompts that were queued after the agent's last turn ended. */
  const drainScheduled = async () => {
    while (schedules !== undefined && agent.hasQueuedMessages() && !signal?.aborted) {
      await agent.continue();
    }
  };

  try {
    const submitted =
      (await options.lifecycleHooks?.onUserPromptSubmit(eventContext, options.prompt)) ??
      options.prompt;
    const prompt = expandPrompt(
      submitted,
      toolRegistry.skillSnapshot?.skills ?? [],
      options.promptTemplates ?? [],
    );
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Native session run was aborted before prompt dispatch.");
    }
    const refineCommand = continual === undefined ? undefined : parseRefineCommand(submitted);
    if (continual !== undefined && refineCommand !== undefined) {
      const result = await continual.refine(agent, refineCommand.options, "user");
      await options.lifecycleHooks?.onStop?.(eventContext);
      return await finish({
        outputText: formatRefinementNotice(result),
        terminalStatus: "completed",
      });
    }
    if (turnMode === "single-turn") {
      await runPrompt(prompt);
      while (longRun !== undefined) {
        const next = await nextLongRunStep();
        if (next === undefined) {
          break;
        }
        await runModelPrompt(next);
      }
      await drainScheduled();
      await options.lifecycleHooks?.onStop?.(eventContext);
      const outputText = assistantText(latestAssistant(agent.state.messages));
      return await finish(outputText === undefined ? {} : { outputText });
    }
    let loop = await runStopToolLoop({
      prompt,
      state: stopState,
      maxTurns: options.maxTurns,
      runPrompt: (text) => runPrompt(text),
    });
    while (longRun !== undefined && loop.stopped && loop.status === "completed") {
      const next = await nextLongRunStep();
      if (next === undefined) {
        break;
      }
      stopState.stopped = false;
      delete stopState.response;
      delete stopState.status;
      loop = await runStopToolLoop({
        prompt: next,
        wrapPrompt: false,
        state: stopState,
        maxTurns: options.maxTurns,
        runPrompt: (text) => runModelPrompt(text),
      });
    }
    await drainScheduled();
    if (loop.stopped && loop.status !== undefined && loop.status !== "completed") {
      longRun?.goal?.pause(`Agent stopped with status "${loop.status}".`);
    }
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
