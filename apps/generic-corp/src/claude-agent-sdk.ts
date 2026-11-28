import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentTool } from "@generic-ai/agent";
import {
  type AssistantMessage,
  type Context,
  calculateCost,
  complete,
  getModel,
  type Model,
  parseModelRef,
  type StreamOptions,
  type Usage,
} from "@generic-ai/ai";
import {
  buildNativeSystemPrompt,
  type CanonicalEventContext,
  createPluginEvent,
  createRunEnvelope,
  type HarnessSessionBackend,
  type HarnessSessionRunOptions,
  type HarnessSessionRunResult,
  resolveCapabilityPiToolRegistry,
} from "@generic-ai/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sdkSessionSidecar } from "./agent-sessions.js";

/**
 * Runs agent turns in the Claude Agent SDK (Claude Code's agent loop), so a company powered by the
 * owner's Claude plan draws on the plan's limits the way Anthropic supports: the owner makes a
 * token with `claude setup-token` (Anthropic's own sign-in) and sets it as
 * `CLAUDE_CODE_OAUTH_TOKEN`; the unmodified Claude Code binary that ships with the SDK uses it.
 * The app never runs a sign-in flow or stores the token itself.
 *
 * The SDK owns the single-agent loop: context handling, retries, prompt caching. Everything above
 * a turn stays ours, and so do the tools: Claude Code's built-in tools are switched off and the
 * agent gets only the run's own tools (files, shell, drive, delegation, goals, memory) through an
 * in-process MCP server. So the permission wall, effect tags, run-as-agent-user isolation and the
 * effect journal all still apply, because every tool call is still one of ours.
 */

export const CLAUDE_AGENT_SDK_ADAPTER = "claude-agent-sdk" as const;
/** The environment variable `claude setup-token`'s token goes in. */
export const CLAUDE_PLAN_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const PLUGIN_ID = "claude-agent-sdk";
const MCP_SERVER = "company";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/** The slice of the SDK's `query` this backend uses; tests pass a stand-in. */
export type ClaudeAgentQuery = (input: {
  prompt: AsyncIterable<ClaudeAgentUserMessage>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK options are passed through as-is
  options: Record<string, any>;
}) => AsyncIterable<ClaudeAgentMessage> & { interrupt(): Promise<unknown> };

export interface ClaudeAgentUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
}

/** The SDK messages this backend reads. Other message types are ignored. */
export interface ClaudeAgentMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly message?: {
    readonly id?: string;
    readonly model?: string;
    readonly usage?: ClaudeApiUsage;
  };
  readonly parent_tool_use_id?: string | null;
  readonly error?: string;
  readonly result?: string;
  readonly is_error?: boolean;
  readonly errors?: readonly string[];
  readonly rate_limit_info?: {
    readonly status?: string;
    readonly resetsAt?: number;
    readonly rateLimitType?: string;
    readonly utilization?: number;
  };
}

interface ClaudeApiUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface ClaudeAgentSdkBackendOptions {
  /** The plan token from `claude setup-token`. Read at each turn, so a new token needs no restart. */
  readonly token: () => string | undefined;
  /**
   * Where the SDK keeps its own state (`CLAUDE_CONFIG_DIR`): session transcripts, so an agent's
   * conversation carries over between turns and survives a restart. Keep it on the data volume and
   * outside agent workspaces.
   */
  readonly configDir: string;
  /** The model when the role names none, as `anthropic/<id>`. */
  readonly defaultModel?: string;
  /** Base system prompt; the run's tool guidance and working directory are added to it. */
  readonly systemPrompt?: string;
  /** The SDK's `query`. Defaults to `@anthropic-ai/claude-agent-sdk`, loaded on first use. */
  readonly query?: ClaudeAgentQuery;
  /** Extra environment for the SDK's process, such as a test model's base URL. */
  readonly env?: Readonly<Record<string, string>>;
  /** Every rate-limit report the SDK makes: how much of each plan window is used, and resets. */
  readonly onRateLimit?: (info: NonNullable<ClaudeAgentMessage["rate_limit_info"]>) => void;
}

/** The model id the SDK takes, from our `anthropic/<id>` reference. */
export function sdkModelId(ref: string): string {
  return ref.startsWith("anthropic/") ? ref.slice("anthropic/".length) : ref;
}

/**
 * The failure message for a turn the plan's usage limit stopped, in the form the plan-limit hold
 * reads (`...|<unix seconds>` carries the reset time).
 */
export function planLimitFailure(resetsAt: number | undefined, kind: string | undefined): string {
  const window = kind === undefined ? "" : ` (${kind.replaceAll("_", " ")})`;
  return `rate_limit_error: Claude plan usage limit reached${window}${
    resetsAt === undefined ? "" : `|${Math.floor(resetsAt)}`
  }`;
}

function usageFrom(ref: string, usage: ClaudeApiUsage): Usage {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const result: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  // What the same tokens would cost on the API: the plan bills by limits, not dollars, but this
  // keeps tokens-per-goal and the spend views comparable across power sources.
  const { provider, id } = parseModelRef(ref.includes("/") ? ref : `anthropic/${ref}`);
  const model = getModel(provider as never, id);
  return model === undefined ? result : calculateCost(model, result);
}

/** Text a tool result carries, for the MCP reply. Images pass through. */
function mcpContent(content: readonly unknown[]) {
  return content.map((part) => {
    const block = part as { type?: string; text?: string; data?: string; mimeType?: string };
    if (block.type === "image" && block.data !== undefined) {
      return { type: "image" as const, data: block.data, mimeType: block.mimeType ?? "image/png" };
    }
    return { type: "text" as const, text: block.text ?? "" };
  });
}

/** A tiny queue the SDK reads the turn's user messages from. */
function createInbox(sessionId: string) {
  const pending: ClaudeAgentUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const nudge = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(text: string) {
      if (closed) return;
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    async *messages(): AsyncGenerator<ClaudeAgentUserMessage> {
      while (true) {
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

interface StoredSdkSession {
  readonly sdkSessionId: string;
}

function readSidecar(sessionFile: string | undefined): StoredSdkSession | undefined {
  if (sessionFile === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(sdkSessionSidecar(sessionFile), "utf8"),
    ) as StoredSdkSession;
    return typeof parsed.sdkSessionId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSidecar(sessionFile: string | undefined, sdkSessionId: string): void {
  if (sessionFile === undefined) return;
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sdkSessionSidecar(sessionFile), `${JSON.stringify({ sdkSessionId })}\n`);
}

let loadedQuery: Promise<ClaudeAgentQuery> | undefined;
function defaultQuery(): Promise<ClaudeAgentQuery> {
  loadedQuery ??= import("@anthropic-ai/claude-agent-sdk").then(
    (sdk) => sdk.query as unknown as ClaudeAgentQuery,
  );
  return loadedQuery;
}

/** The SDK process's environment: only what it needs, never the server's own secrets. */
function sdkEnvironment(
  options: Pick<ClaudeAgentSdkBackendOptions, "configDir" | "env">,
  token: string,
): Record<string, string> {
  const pass = ["PATH", "HOME", "LANG", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const env: Record<string, string> = {};
  for (const name of pass) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: options.configDir,
    [CLAUDE_PLAN_TOKEN_ENV]: token,
    // Claude Code's own extras each cost model calls or read files we don't want in a turn.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ...options.env,
  };
}

export function createClaudeAgentSdkBackend(
  options: ClaudeAgentSdkBackendOptions,
): HarnessSessionBackend {
  return Object.freeze({
    kind: CLAUDE_AGENT_SDK_ADAPTER,
    label: "Claude Agent SDK",
    run: (runOptions: HarnessSessionRunOptions) => runSdkSession(options, runOptions),
  });
}

async function runSdkSession(
  options: ClaudeAgentSdkBackendOptions,
  run: HarnessSessionRunOptions,
): Promise<HarnessSessionRunResult> {
  const createdAt = new Date().toISOString();
  const stored = readSidecar(run.sessionFile);
  // One SDK session per agent per goal, like the native session files: a new turn on the same
  // goal continues the conversation, and a turn a restart cut off picks up where it stopped.
  const sessionId = stored?.sdkSessionId ?? randomUUID();
  const context: CanonicalEventContext = {
    scopeId: run.rootScopeId,
    runId: run.runId,
    rootSessionId: run.rootSessionId ?? sessionId,
    sessionId,
    ...(run.parentSessionId === undefined ? {} : { parentSessionId: run.parentSessionId }),
  };
  const emit = (localName: string, data: Record<string, unknown>) =>
    run.eventStream.emit(
      createPluginEvent(PLUGIN_ID, localName, {
        ...context,
        origin: { subsystem: "claude-agent-sdk" },
        data: data as never,
      }),
    );

  const registry = await resolveCapabilityPiToolRegistry(run.capabilities);
  const tools = [...registry.tools, ...registry.customTools] as unknown as AgentTool[];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const modelRef = run.role?.model ?? options.defaultModel ?? DEFAULT_MODEL;
  const token = options.token()?.trim();

  const finish = async (outputText: string, failureMessage?: string) => {
    const failed = failureMessage !== undefined;
    const data = failed ? { error: failureMessage } : {};
    await run.eventStream.emit({
      ...context,
      name: failed ? "session.failed" : "session.completed",
      data,
    });
    await run.eventStream.emit({ ...context, name: failed ? "run.failed" : "run.completed", data });
    const events = run.eventStream.snapshot();
    const lastSequence = events.at(-1)?.sequence;
    return {
      sessionId,
      outputText,
      ...(failed ? { failureMessage } : {}),
      events,
      envelope: createRunEnvelope({
        runId: run.runId,
        rootScopeId: run.rootScopeId,
        rootAgentId: run.rootAgentId,
        mode: "sync",
        status: failed ? "failed" : "succeeded",
        timestamps: { createdAt, startedAt: createdAt, completedAt: new Date().toISOString() },
        eventStream: {
          kind: "event-stream-reference",
          streamId: run.runId,
          ...(lastSequence === undefined ? {} : { sequence: lastSequence }),
        },
      }),
    } satisfies HarnessSessionRunResult;
  };

  await run.eventStream.emit({
    ...context,
    name: "run.created",
    data: { toolNames: tools.map((tool) => tool.name), model: modelRef },
  });
  await run.eventStream.emit({ ...context, name: "session.created", data: { sessionId } });
  await run.onSessionReady?.(context);
  await run.lifecycleHooks?.onSessionStart?.(context);
  await run.eventStream.emit({ ...context, name: "run.started" });
  await run.eventStream.emit({ ...context, name: "session.started" });

  if (token === undefined || token.length === 0) {
    return finish(
      "",
      `No Claude plan token. Run \`claude setup-token\` and set ${CLAUDE_PLAN_TOKEN_ENV}.`,
    );
  }

  // The run's tools, served to the SDK as one in-process MCP server with their own JSON schemas.
  const mcp = new McpServer(
    { name: MCP_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.label ?? tool.name,
      inputSchema: (tool.parameters ?? { type: "object", properties: {} }) as {
        type: "object";
      },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const tool = byName.get(name);
    if (tool === undefined) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] };
    }
    const toolCallId = randomUUID();
    const args = request.params.arguments ?? {};
    await emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId,
      toolName: name,
    });
    try {
      const prepared = tool.prepareArguments === undefined ? args : tool.prepareArguments(args);
      const result = await tool.execute(toolCallId, prepared, extra.signal);
      await emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId,
        toolName: name,
        isError: result.isError === true,
      });
      return {
        ...(result.isError === true ? { isError: true } : {}),
        content: mcpContent(result.content),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId,
        toolName: name,
        isError: true,
      });
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  const submitted =
    run.resume === true && stored !== undefined
      ? "Your previous turn was interrupted. Continue the task from where you left off."
      : ((await run.lifecycleHooks?.onUserPromptSubmit(context, run.prompt)) ?? run.prompt);
  const inbox = createInbox(sessionId);
  inbox.push(submitted);
  const abort = new AbortController();
  const onAbort = () => abort.abort(run.signal?.reason);
  run.signal?.addEventListener("abort", onAbort, { once: true });

  const query = options.query ?? (await defaultQuery());
  const systemPrompt = buildNativeSystemPrompt({
    ...(options.systemPrompt === undefined ? {} : { base: options.systemPrompt }),
    cwd: run.cwd,
    tools: tools as never,
    ...(registry.skillSnapshot === undefined
      ? {}
      : { skillsPrompt: registry.skillSnapshot.prompt }),
  });
  const stream = query({
    prompt: inbox.messages(),
    options: {
      model: sdkModelId(modelRef),
      cwd: run.cwd,
      systemPrompt,
      // Only our tools: Claude Code's own (Bash, Read, Edit, web...) are off.
      tools: [],
      mcpServers: { [MCP_SERVER]: { type: "sdk", name: MCP_SERVER, instance: mcp } },
      // Our tools check permissions themselves; anything else the SDK asks about is refused.
      canUseTool: async (toolName: string, input: Record<string, unknown>) =>
        toolName.startsWith(MCP_PREFIX)
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Only the company's tools are available." },
      settingSources: [],
      ...(stored === undefined ? { sessionId } : { resume: stored.sdkSessionId }),
      abortController: abort,
      env: sdkEnvironment(options, token),
    },
  });
  writeSidecar(run.sessionFile, sessionId);

  // Steering: messages for the agent while it works join the turn after its current step.
  let steeringTimer: ReturnType<typeof setInterval> | undefined;
  if (run.steering !== undefined) {
    const steering = run.steering;
    steeringTimer = setInterval(() => {
      void Promise.resolve(steering())
        .then((messages) => {
          for (const message of messages) inbox.push(message);
        })
        .catch(() => undefined);
    }, 1000);
  }

  // Usage: one record per model response, when the next one starts or the turn ends (a response
  // streams as several messages that share its id; the last carries the final counts).
  let open: { id: string; model: string; usage: ClaudeApiUsage } | undefined;
  const flushUsage = async () => {
    if (open === undefined) return;
    const { id, model, usage } = open;
    open = undefined;
    await run.usageMeter?.record(
      { ...context, roleId: run.role?.id ?? run.rootAgentId },
      { provider: "anthropic", model, usage: usageFrom(model, usage), responseId: id },
    );
  };

  let outputText = "";
  let failure: string | undefined;
  let planLimit: string | undefined;
  let stopped = false;
  try {
    for await (const message of stream) {
      if (message.type === "assistant" && message.message?.usage !== undefined) {
        const id = message.message.id ?? randomUUID();
        if (open !== undefined && open.id !== id) await flushUsage();
        open = {
          id,
          model: message.message.model ?? sdkModelId(modelRef),
          usage: message.message.usage,
        };
        if (message.error === "rate_limit" && planLimit === undefined) {
          planLimit = planLimitFailure(undefined, undefined);
        }
        if (
          message.error !== undefined &&
          message.error !== "rate_limit" &&
          message.parent_tool_use_id == null
        ) {
          await emit("model_error", { type: "model_error", error: message.error });
        }
      } else if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info !== undefined) options.onRateLimit?.(info);
        if (info?.status === "rejected") {
          planLimit = planLimitFailure(info.resetsAt, info.rateLimitType);
        }
      } else if (message.type === "result") {
        await flushUsage();
        if (message.subtype === "success" && message.is_error !== true) {
          outputText = message.result ?? "";
        } else {
          failure =
            planLimit ??
            (stopped ? "Stopped: the agent was held mid-turn." : undefined) ??
            (message.errors?.join("; ") || message.result || `Turn ended: ${message.subtype}.`);
        }
        inbox.close();
      }
      if (!stopped && run.stopRequested !== undefined && (await run.stopRequested())) {
        // Held (paused, a plan limit, a spend limit): stop now. The SDK session keeps what the
        // turn did, and the next attempt resumes it.
        stopped = true;
        await stream.interrupt();
        inbox.close();
      }
    }
    await flushUsage();
  } catch (error) {
    await flushUsage();
    failure =
      planLimit ??
      (stopped ? "Stopped: the agent was held mid-turn." : undefined) ??
      (run.signal?.aborted === true && run.signal.reason instanceof Error
        ? run.signal.reason.message
        : error instanceof Error
          ? error.message
          : String(error));
  } finally {
    if (steeringTimer !== undefined) clearInterval(steeringTimer);
    inbox.close();
    run.signal?.removeEventListener("abort", onAbort);
    await mcp.close().catch(() => undefined);
  }
  if (failure === undefined && run.usageMeter?.exceeded !== undefined) {
    failure = run.usageMeter.exceeded.message;
  }
  if (failure === undefined) {
    await run.lifecycleHooks?.onStop?.(context);
  }
  return finish(outputText, failure);
}

/** `complete` from `@generic-ai/ai`, or a stand-in with the same shape. */
export type CompleteFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => Promise<AssistantMessage>;

export interface ClaudePlanCompletionOptions {
  readonly token: () => string | undefined;
  readonly configDir: string;
  /** Whether one-shot calls on Claude models go to the plan right now. */
  readonly active: () => boolean | Promise<boolean>;
  readonly query?: ClaudeAgentQuery;
  readonly env?: Readonly<Record<string, string>>;
  readonly onRateLimit?: ClaudeAgentSdkBackendOptions["onRateLimit"];
  /** Used for other models and while the plan is off. Defaults to `complete`. */
  readonly fallback?: CompleteFn;
}

function contextAsPrompt(context: Context): string {
  return context.messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          (part as { type?: string }).type === "text" ? (part as { text: string }).text : "",
        )
        .join("\n");
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * One-shot model calls (the rubric judge, second opinions, dreaming) on the owner's Claude plan:
 * the call runs as a single tool-less SDK turn and comes back shaped like `complete`'s reply, so
 * callers don't change. Other models, and every call while the plan is off, use `fallback`.
 */
export function createClaudePlanCompletion(options: ClaudePlanCompletionOptions): CompleteFn {
  const fallback = options.fallback ?? complete;
  return async (model, context, streamOptions) => {
    const token = options.token()?.trim();
    if (model.provider !== "anthropic" || token === undefined || !(await options.active())) {
      return fallback(model, context, streamOptions);
    }
    const started = Date.now();
    const sessionId = randomUUID();
    const inbox = createInbox(sessionId);
    inbox.push(contextAsPrompt(context));
    inbox.close();
    const abort = new AbortController();
    const signal = streamOptions?.signal;
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const query = options.query ?? (await defaultQuery());
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const responses = new Map<string, ClaudeApiUsage>();
    let text = "";
    let errorMessage: string | undefined;
    let planLimit: string | undefined;
    try {
      const stream = query({
        prompt: inbox.messages(),
        options: {
          model: model.id,
          ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
          tools: [],
          settingSources: [],
          maxTurns: 1,
          persistSession: false,
          sessionId,
          abortController: abort,
          env: sdkEnvironment(options, token),
        },
      });
      for await (const message of stream) {
        if (message.type === "assistant" && message.message?.usage !== undefined) {
          responses.set(message.message.id ?? randomUUID(), message.message.usage);
          if (message.error === "rate_limit") planLimit ??= planLimitFailure(undefined, undefined);
        } else if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info !== undefined) options.onRateLimit?.(info);
          if (info?.status === "rejected") {
            planLimit = planLimitFailure(info.resetsAt, info.rateLimitType);
          }
        } else if (message.type === "result") {
          if (message.subtype === "success" && message.is_error !== true) {
            text = message.result ?? "";
          } else {
            errorMessage =
              planLimit ??
              (message.errors?.join("; ") || message.result || `Call ended: ${message.subtype}.`);
          }
        }
      }
    } catch (error) {
      errorMessage = planLimit ?? (error instanceof Error ? error.message : String(error));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    for (const response of responses.values()) {
      const one = usageFrom(`anthropic/${model.id}`, response);
      usage.input += one.input;
      usage.output += one.output;
      usage.cacheRead += one.cacheRead;
      usage.cacheWrite += one.cacheWrite;
      usage.totalTokens += one.totalTokens;
      usage.cost.input += one.cost.input;
      usage.cost.output += one.cost.output;
      usage.cost.cacheRead += one.cost.cacheRead;
      usage.cost.cacheWrite += one.cost.cacheWrite;
      usage.cost.total += one.cost.total;
    }
    const aborted = signal?.aborted === true;
    return {
      role: "assistant",
      content: text.length === 0 ? [] : [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: aborted ? "aborted" : errorMessage === undefined ? "stop" : "error",
      ...(errorMessage === undefined ? {} : { errorMessage }),
      timestamp: started,
      durationMs: Date.now() - started,
    };
  };
}
