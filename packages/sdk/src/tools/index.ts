import type { Static, TSchema } from "@sinclair/typebox";

/** Text returned to the model by a tool. */
export interface ToolTextContent {
  type: "text";
  text: string;
}

/** Image returned to the model by a tool, base64 encoded. */
export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** What a tool returns. */
export interface AgentToolResult<TDetails = unknown> {
  /** Text or images returned to the model. */
  content: (ToolTextContent | ToolImageContent)[];
  /** Structured details for logs and UIs. Not sent to the model. */
  details: TDetails;
  /** Report a failure without throwing; the model sees `content` as an error result. */
  isError?: boolean;
  /** Stop after this batch of tool calls when every result in the batch terminates. */
  terminate?: boolean;
}

/** Streams partial results while a tool runs. */
export type AgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: AgentToolResult<TDetails>,
) => void;

/** Whether a tool may run concurrently with other tool calls in the same batch. */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * A tool an agent can call, independent of the runtime that runs it. Plugins define tools with this
 * contract and the harness hands them to the session backend.
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** Tool name used in model tool calls. */
  name: string;
  /** Human-readable label for UIs. */
  label: string;
  /** Description sent to the model. */
  description: string;
  /** One-line summary for an "available tools" section of a system prompt. */
  promptSnippet?: string;
  /** Guideline bullets added to the system prompt while this tool is active. */
  promptGuidelines?: string[];
  /** Parameter schema (TypeBox). */
  parameters: TParams;
  /** Compatibility shim applied to raw arguments before schema validation. */
  prepareArguments?: (args: unknown) => Static<TParams>;
  /** Force this tool to run alone ("sequential") even when the runtime runs tools in parallel. */
  executionMode?: ToolExecutionMode;
  /**
   * Run the tool. Throw on failure, or return `isError: true`. `context` is runtime-specific and
   * optional; portable tools do not read it.
   */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    context?: unknown,
  ): Promise<AgentToolResult<TDetails>>;
}

// biome-ignore lint/suspicious/noExplicitAny: the widened form lets tools with different schemas share one array
export type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * Define a tool while keeping its parameter types. Use it when assigning a tool to a variable or
 * putting it in an array, where contextual typing would otherwise widen the parameters to `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails> & AnyToolDefinition;
}
