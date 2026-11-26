import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolExecutionMode,
} from "@generic-ai/agent";
import type { Model } from "@generic-ai/ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** Per-call context a host may pass to a tool. Every field is optional. */
export interface ToolContext {
  /** Working directory for this call; overrides the directory the tool was created with. */
  readonly cwd?: string | undefined;
  /** The model making the call. */
  readonly model?: Model | undefined;
  /** Stable id of the session, exported to shell commands as GENERIC_AI_SESSION_ID. */
  readonly sessionId?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

/** Back-compat name used by code adapted from pi. */
export type ExtensionContext = ToolContext;
export type ExtensionToolContext = ToolContext;

export type ConstrainedSamplingConfig = {
  readonly type: "json_schema";
  readonly strict: "prefer" | "require";
};

/**
 * A tool definition: an agent tool plus prompt metadata and an optional per-call context. Spread
 * into an `AgentTool` with `wrapToolDefinition`.
 */
// biome-ignore lint/suspicious/noExplicitAny: render state is unused here; kept for signature parity with pi
export interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  _TState = any,
> {
  name: string;
  label: string;
  description: string;
  /** One-line summary for the system prompt's tool list. */
  promptSnippet?: string | undefined;
  /** Guideline bullets for the system prompt while the tool is active. */
  promptGuidelines?: string[] | undefined;
  parameters: TParams;
  constrainedSampling?: false | ConstrainedSamplingConfig | undefined;
  renderShell?: "default" | "self" | undefined;
  prepareArguments?: (args: unknown) => Static<TParams>;
  outputSchema?: TSchema | undefined;
  executionMode?: ToolExecutionMode | undefined;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx?: ToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}
