// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/extensions/types.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// A runtime-only subset of pi's extension API: no TUI, keybindings, renderers, or flags. The event
// names, payloads, and result-chaining rules follow pi so pi extensions that only use these hooks
// port with small changes.

import type {
  AgentMessage,
  AgentThinkingLevel,
  AgentTool,
  AgentToolResult,
} from "@generic-ai/agent";
import type {
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
  ToolResultMessage,
} from "@generic-ai/ai";

/** Context passed to every handler, tool, and command. */
export interface ExtensionContext {
  /** Working directory of the session. */
  readonly cwd: string;
  /** Abort signal of the current agent run, when one is active. */
  readonly signal: AbortSignal | undefined;
  /** The system prompt the next request will use. */
  getSystemPrompt(): string;
  /** The live conversation. */
  getMessages(): readonly AgentMessage[];
  /** Queue a message that is delivered to the model after the current turn. */
  sendMessage(message: AgentMessage): void;
  /** The model the next request will use, once an agent is bound. */
  getModel(): Model | undefined;
  /** Switch the model from the next prompt. Fires `model_select`. */
  setModel(model: Model): Promise<void>;
  /** The reasoning level the next request will use. */
  getThinkingLevel(): AgentThinkingLevel | undefined;
  /** Switch the reasoning level from the next prompt. Fires `thinking_level_select`. */
  setThinkingLevel(level: AgentThinkingLevel): Promise<void>;
}

// --- Events -----------------------------------------------------------------------------------

export interface SessionStartEvent {
  readonly type: "session_start";
}

export interface SessionShutdownEvent {
  readonly type: "session_shutdown";
}

/** A prompt is about to be submitted. Handlers may rewrite it or mark it handled. */
export interface InputEvent {
  readonly type: "input";
  readonly text: string;
}

export type InputEventResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string }
  | { readonly action: "handled" };

/** The agent is about to start on a prompt. Handlers may change the system prompt. */
export interface BeforeAgentStartEvent {
  readonly type: "before_agent_start";
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface BeforeAgentStartEventResult {
  /** Replaces the system prompt; later handlers see the replacement. */
  readonly systemPrompt?: string;
  /** Messages added to the conversation before the prompt. */
  readonly messages?: readonly AgentMessage[];
}

export interface AgentStartEvent {
  readonly type: "agent_start";
}

export interface AgentEndEvent {
  readonly type: "agent_end";
  readonly messages: readonly AgentMessage[];
}

export interface TurnStartEvent {
  readonly type: "turn_start";
  readonly turnIndex: number;
}

export interface TurnEndEvent {
  readonly type: "turn_end";
  readonly turnIndex: number;
  readonly message: AgentMessage;
  readonly toolResults: readonly ToolResultMessage[];
}

export interface MessageEndEvent {
  readonly type: "message_end";
  readonly message: AgentMessage;
}

/** The messages about to be sent to the model. Handlers may return a replacement list. */
export interface ContextEvent {
  readonly type: "context";
  readonly messages: readonly AgentMessage[];
}

export interface ContextEventResult {
  readonly messages?: readonly AgentMessage[];
}

/** A tool call passed validation and is about to run. */
export interface ToolCallEvent {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly assistantMessage: AssistantMessage;
}

export interface ToolCallEventResult {
  /** Skip the tool; the model sees `reason` as an error result. The first block wins. */
  readonly block?: boolean;
  readonly reason?: string;
}

/** A tool finished. Handlers may patch the result; patches chain across handlers. */
export interface ToolResultEvent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly content: readonly (TextContent | ImageContent)[];
  readonly details: unknown;
  readonly isError: boolean;
}

export interface ToolResultEventResult {
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface SessionBeforeCompactEvent {
  readonly type: "session_before_compact";
  readonly tokens: number;
  readonly contextWindow: number;
}

export interface SessionBeforeCompactEventResult {
  /** Skip this compaction. */
  readonly cancel?: boolean;
  /** Extra instructions for the summary. */
  readonly customInstructions?: string;
}

export interface SessionCompactEvent {
  readonly type: "session_compact";
  readonly summary: string;
  readonly tokensBefore: number;
}

/** A replacement provider payload (request bodies are JSON objects). */
export type BeforeProviderRequestEventResult = object;

/** A provider request is about to be sent. A handler may return a replacement payload. */
export interface BeforeProviderRequestEvent {
  readonly type: "before_provider_request";
  readonly payload: unknown;
  readonly model: Model;
}

/**
 * Request headers are being assembled. Handlers mutate `headers` in place (for example to add
 * tracing headers); a `null` value removes a header the model or caller set. Provider defaults
 * (authentication, API version) are added after this and cannot be changed here.
 */
export interface BeforeProviderHeadersEvent {
  readonly type: "before_provider_headers";
  readonly headers: Record<string, string | null>;
  readonly model: Model;
}

/** A provider HTTP response arrived (before its stream is read). */
export interface AfterProviderResponseEvent {
  readonly type: "after_provider_response";
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly model: Model;
}

export type ModelSelectSource = "set" | "restore";

export interface ModelSelectEvent {
  readonly type: "model_select";
  readonly model: Model;
  readonly previousModel: Model | undefined;
  readonly source: ModelSelectSource;
}

export interface ThinkingLevelSelectEvent {
  readonly type: "thinking_level_select";
  readonly level: AgentThinkingLevel;
  readonly previousLevel: AgentThinkingLevel | undefined;
}

export interface ExtensionEventMap {
  session_start: [SessionStartEvent, undefined];
  session_shutdown: [SessionShutdownEvent, undefined];
  input: [InputEvent, InputEventResult];
  before_agent_start: [BeforeAgentStartEvent, BeforeAgentStartEventResult];
  agent_start: [AgentStartEvent, undefined];
  agent_end: [AgentEndEvent, undefined];
  turn_start: [TurnStartEvent, undefined];
  turn_end: [TurnEndEvent, undefined];
  message_end: [MessageEndEvent, undefined];
  context: [ContextEvent, ContextEventResult];
  tool_call: [ToolCallEvent, ToolCallEventResult];
  tool_result: [ToolResultEvent, ToolResultEventResult];
  session_before_compact: [SessionBeforeCompactEvent, SessionBeforeCompactEventResult];
  session_compact: [SessionCompactEvent, undefined];
  before_provider_request: [BeforeProviderRequestEvent, BeforeProviderRequestEventResult];
  before_provider_headers: [BeforeProviderHeadersEvent, undefined];
  after_provider_response: [AfterProviderResponseEvent, undefined];
  model_select: [ModelSelectEvent, undefined];
  thinking_level_select: [ThinkingLevelSelectEvent, undefined];
}

export type ExtensionEventName = keyof ExtensionEventMap;
export type ExtensionEvent = ExtensionEventMap[ExtensionEventName][0];

export type ExtensionHandler<K extends ExtensionEventName> = (
  event: ExtensionEventMap[K][0],
  context: ExtensionContext,
) =>
  | ExtensionEventMap[K][1]
  | undefined
  // biome-ignore lint/suspicious/noConfusingVoidType: handlers may return nothing.
  | void
  // biome-ignore lint/suspicious/noConfusingVoidType: handlers may return nothing.
  | Promise<ExtensionEventMap[K][1] | undefined | void>;

// --- Registration -----------------------------------------------------------------------------

export interface ExtensionCommand {
  readonly description?: string;
  /** Runs when a prompt is `/name args`. The prompt is then not sent to the model. */
  handler(args: string, context: ExtensionContext): Promise<void> | void;
}

export interface RegisteredCommand extends ExtensionCommand {
  /** The name the extension asked for. */
  readonly name: string;
  /** The name to type: `name`, or `name:2`, `name:3`… when several extensions use one name. */
  readonly invocationName: string;
  readonly extensionPath: string;
}

/** The object an extension factory receives. */
export interface ExtensionAPI {
  on<K extends ExtensionEventName>(event: K, handler: ExtensionHandler<K>): () => void;
  // biome-ignore lint/suspicious/noExplicitAny: tools carry arbitrary parameter and detail types.
  registerTool(tool: AgentTool<any, any>): void;
  registerCommand(name: string, command: ExtensionCommand): void;
}

/** An extension module's default export. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface Extension {
  /** File the extension was loaded from, or `<inline:name>` for a factory. */
  readonly path: string;
}

export interface ExtensionError {
  readonly extensionPath: string;
  readonly event: string;
  readonly error: string;
}

export type { AgentToolResult };
