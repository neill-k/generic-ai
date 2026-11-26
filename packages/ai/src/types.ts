/**
 * Provider-neutral message, model, and streaming types for the Generic AI native runtime.
 *
 * The vocabulary (roles, content blocks, the assistant event protocol) deliberately follows the
 * shape used by pi-ai so that pi's behavioural tests can be adapted to this runtime. See
 * THIRD_PARTY_NOTICES.md in this package.
 */

import type { AssistantMessageEventStream } from "./event-stream.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** Wire protocols the runtime can speak. Custom APIs can be registered with `registerApi()`. */
export type KnownApi = "anthropic-messages" | "openai-responses" | "openai-completions" | "faux";
export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "groq"
  | "xai"
  | "deepseek"
  | "mistral"
  | "ollama"
  | "faux";
export type ProviderId = KnownProvider | (string & {});

/** Reasoning effort requested from models that support it. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThinkingBudgets {
  readonly minimal?: number;
  readonly low?: number;
  readonly medium?: number;
  readonly high?: number;
  readonly xhigh?: number;
}

export type ToolChoice = "auto" | "none" | "required" | { readonly name: string };

export interface TextContent {
  type: "text";
  text: string;
  /** Provider-specific opaque metadata used to replay the block (for example an OpenAI message id). */
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Provider-specific opaque replay data (Anthropic signature, OpenAI encrypted reasoning item). */
  thinkingSignature?: string;
  /** True when the provider redacted the reasoning; the opaque payload lives in `thinkingSignature`. */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  /** Base64 encoded bytes. */
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  /**
   * Set when the model's complete arguments text was not a valid JSON object. `arguments` is then `{}`
   * and tool argument validation fails with this message.
   */
  argumentsError?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning tokens when reported. A subset of `output`. */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** `pending` only appears on in-flight partial messages, never on a final one. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";

/** Prompt-cache retention. `none` disables caching hints; `long` asks for extended retention where supported. */
export type CacheRetention = "none" | "short" | "long";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  /** Concrete model reported by the provider when it differs from or refines `model`. */
  responseModel?: string;
  responseId?: string;
  /** Thinking level the agent loop requested for this response. */
  thinkingLevel?: ThinkingLevel | "off";
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** Raw provider stop/finish reason, kept for debugging. */
  rawStopReason?: string;
  /** Unix ms when the request started. */
  timestamp: number;
  /** Monotonic milliseconds from request start to the final event. */
  durationMs?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  /** Usage of the tool execution itself (for example a nested model call). Not context accounting. */
  usage?: Usage;
  isError: boolean;
  timestamp: number;
  /** Milliseconds `execute()` took, when the tool ran. */
  durationMs?: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** A tool the model may call. `parameters` is a JSON Schema object (TypeBox schemas qualify). */
export interface Tool<TParameters extends object = object> {
  name: string;
  description: string;
  parameters: TParameters;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export interface ModelCost {
  /** USD per million input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  /** Whether the model accepts reasoning/thinking controls. */
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  /**
   * How the model takes reasoning controls on APIs that distinguish them: "adaptive" (Anthropic
   * Claude 4.6+: adaptive thinking plus an effort level), "budget" (older Claude models: a thinking
   * token budget), or "none". Defaults to "adaptive" when `reasoning` is true.
   */
  thinkingMode?: "adaptive" | "budget" | "none";
  /** Provider quirks for OpenAI-compatible endpoints. Auto-detected from `baseUrl` when omitted. */
  compat?: OpenAICompletionsCompat;
}

export interface OpenAICompletionsCompat {
  /** Send `max_completion_tokens` instead of `max_tokens`. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Send `reasoning_effort`. */
  readonly supportsReasoningEffort?: boolean;
  /** Ask for usage in the final streamed chunk. */
  readonly supportsUsageInStreaming?: boolean;
  /** Use the `developer` role for the system prompt. */
  readonly supportsDeveloperRole?: boolean;
  /** Field carrying streamed reasoning text (`reasoning_content`, `reasoning`). */
  readonly reasoningField?: "reasoning_content" | "reasoning";
}

export interface StreamOptions {
  apiKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Reasoning effort. Omit (or use `undefined`) for no reasoning. */
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  toolChoice?: ToolChoice;
  /** Stable conversation id. Providers use it for prompt-cache affinity. */
  sessionId?: string;
  /** Prompt-cache retention. Default "short". */
  cacheRetention?: CacheRetention;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Inspect or replace the provider payload before it is sent. */
  onPayload?: (
    payload: unknown,
    model: Model,
  ) => unknown | undefined | Promise<unknown | undefined>;
  /** Observe the raw HTTP response (status, headers). */
  onResponse?: (
    response: { status: number; headers: Headers },
    model: Model,
  ) => void | Promise<void>;
  /** Maximum retries for retryable HTTP failures (408, 409, 429, 5xx, network). Default 2. */
  maxRetries?: number;
}

export type StreamFunction<TApi extends Api = Api> = (
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream;

/**
 * Event protocol for one assistant response.
 *
 * `start` comes first, then block events, then exactly one terminal `done` or `error`. A stream may
 * terminate with `error` without `start` when the request fails before generation begins. `partial`
 * is the live response-so-far.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
