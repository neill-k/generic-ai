import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@generic-ai/agent";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ToolContext, ToolDefinition } from "./types.js";

/** An `AgentTool` whose `execute` params are typed by its TypeBox schema. */
// biome-ignore lint/suspicious/noExplicitAny: details are tool-specific
export type TypeBoxAgentTool<TParams extends TSchema = TSchema, TDetails = any> = Omit<
  AgentTool<TParams, TDetails>,
  "prepareArguments" | "execute"
> & {
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<TParams>;
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
};

/** Creates the context for one tool call. */
export type ToolContextFactory = (
  toolCallId: string,
  signal: AbortSignal | undefined,
) => ToolContext | undefined;

/** Turn a tool definition into an agent tool. Prompt metadata is kept so hosts can build system prompts. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous definitions
export function wrapToolDefinition<TDetails = unknown>(
  definition: ToolDefinition<any, TDetails>,
  ctxFactory?: ToolContextFactory,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous definitions
): TypeBoxAgentTool<any, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: definition.promptGuidelines }),
    ...(definition.prepareArguments === undefined
      ? {}
      : { prepareArguments: definition.prepareArguments }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.(toolCallId, signal)),
  };
}
