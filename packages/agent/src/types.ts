import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  JsonValue,
  Message,
  Model,
  StreamOptions,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@generic-ai/ai";

/**
 * Stream function used by the agent loop. `stream` from `@generic-ai/ai` satisfies it.
 *
 * Contract: never throw or reject for request/model failures; encode them in the returned stream
 * as a terminal `error` event whose message has stopReason "error" or "aborted".
 */
export type StreamFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Requested reasoning level. "off" sends no reasoning control. */
export type AgentThinkingLevel = ThinkingLevel | "off";

/**
 * - "sequential": each tool call is prepared, executed, and finalized before the next starts.
 * - "parallel": calls are prepared in order, then allowed tools run concurrently;
 *   `tool_execution_end` fires in completion order, tool-result messages in source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** "all" drains every queued message at a drain point; "one-at-a-time" only the oldest. */
export type QueueMode = "all" | "one-at-a-time";

export type AgentToolCall = ToolCall;

/** Returned from `beforeToolCall`. `block: true` skips execution and reports `reason` as an error result. */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /** Stop after this batch when every result in the batch terminates. */
  terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`, merged field by field (no deep merge). When
 * `content` is replaced without `structuredContent`, the structured content is dropped because it
 * may no longer match.
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  structuredContent?: JsonValue;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  /** Validated (and coerced) arguments. */
  args: unknown;
  context: AgentContext;
}

export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  /** The executed result before overrides. */
  result: AgentToolResult<unknown>;
  isError: boolean;
  context: AgentContext;
}

export interface AgentTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  /** Context after the turn's assistant message and tool results were appended. */
  context: AgentContext;
  /** Messages this run would return if it ended now. */
  newMessages: AgentMessage[];
}

export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * Called after a completed turn (assistant message plus tool results), before `turn_end`.
 * `{ action: "end" }` ends the run. `{ action: "continue" }` guarantees one more provider request;
 * a request the loop makes anyway (tool results, steering, follow-ups) satisfies it.
 */
export type FinishTurn = (
  turn: AgentTurnContext,
  signal?: AbortSignal,
) => AgentTurnDecision | undefined | Promise<AgentTurnDecision | undefined>;

/** Replacement runtime state applied before the next provider request. */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  /** Appended before the next request, with normal message events. */
  messages?: AgentMessage[];
  model?: Model;
  thinkingLevel?: AgentThinkingLevel;
}

export interface PrepareRequestContext {
  context: AgentContext;
  model: Model;
  thinkingLevel: AgentThinkingLevel;
}

export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/** Called immediately before every provider request, after pending messages were appended. */
export type PrepareRequest = (
  request: PrepareRequestContext,
  signal?: AbortSignal,
) => AgentRequestUpdate | undefined | Promise<AgentRequestUpdate | undefined>;

export type PrepareNextTurnContext = AgentTurnContext;

export interface AgentLoopConfig extends Omit<StreamOptions, "signal" | "reasoning"> {
  model: Model;
  /** Requested reasoning level; "off" or undefined sends none. */
  thinkingLevel?: AgentThinkingLevel;
  /**
   * Convert agent messages to LLM messages before each request. Filter out app-only messages.
   * Must not throw.
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** Transform the agent-level context before conversion (pruning, injection). Must not throw. */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Resolve an API key per request (short-lived tokens). Must not throw. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  finishTurn?: FinishTurn;
  prepareRequest?: PrepareRequest;
  /** Called after `turn_end` when the loop continues, before the next turn starts. */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /** Messages to inject after the current turn's tools finish. Must not throw. */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /** Messages to process when the agent would otherwise stop. Must not throw. */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /** Default "parallel". */
  toolExecution?: ToolExecutionMode;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Custom app messages. Extend by declaration merging:
 *
 * ```ts
 * declare module "@generic-ai/agent" {
 *   interface CustomAgentMessages { notification: { role: "notification"; text: string; timestamp: number } }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentToolResult<TDetails = unknown> {
  /** Text or images returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Structured details for logs and UIs. Not sent to the model. */
  details: TDetails;
  /** Machine-readable result matching `outputSchema`, for programmatic callers. Not sent to the model. */
  structuredContent?: JsonValue;
  usage?: Usage;
  /** Report a failure without throwing; the model sees `content` as an error result. */
  isError?: boolean;
  /** Stop after this batch when every result in the batch terminates. */
  terminate?: boolean;
}

export interface AgentToolCallOutcome {
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
  /** Milliseconds `execute()` took; absent when the tool did not run. */
  durationMs?: number;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: AgentToolResult<TDetails>,
) => void;

/** An executable tool. `parameters` is a JSON Schema (TypeBox schemas qualify). */
export interface AgentTool<TParameters extends object = object, TDetails = unknown>
  extends Tool<TParameters> {
  /** Human-readable label for UIs. */
  label: string;
  /** Compatibility shim applied to raw arguments before validation. */
  prepareArguments?: (args: unknown) => unknown;
  /** JSON Schema of `structuredContent` in successful results. */
  outputSchema?: object;
  /** Execute the call. Throw on failure, or return `isError: true`. */
  execute: (
    toolCallId: string,
    // biome-ignore lint/suspicious/noExplicitAny: validated arguments are typed by the tool author
    params: any,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Force this tool to run alone ("sequential") even in parallel mode. */
  executionMode?: ToolExecutionMode;
}

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
  tools?: AgentTool<any, any>[] | undefined;
}

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: AgentThinkingLevel;
  /** Assigning copies the array. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
  set tools(tools: AgentTool<any, any>[]);
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
  get tools(): AgentTool<any, any>[];
  /** Assigning copies the array. */
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  /** True while a prompt or continuation runs, until awaited `agent_end` listeners settle. */
  readonly isStreaming: boolean;
  /** Partial message currently streaming, if any. */
  readonly streamingMessage?: AgentMessage | undefined;
  /** Tool call ids currently executing. */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** Error of the most recent failed or aborted turn. */
  readonly errorMessage?: string | undefined;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult<unknown>;
      isError: boolean;
      durationMs?: number;
    };
