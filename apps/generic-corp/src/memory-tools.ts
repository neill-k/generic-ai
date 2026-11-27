import { defineTool, type ToolDefinition, withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { type Static, Type } from "@sinclair/typebox";

import { agentScope, type CompanyMemory } from "./memory.js";

const REMEMBER_PARAMETERS = Type.Object({
  title: Type.String({ description: "A few words naming the memory." }),
  content: Type.String({
    description: "The lesson, decision or fact, short and specific enough to act on later.",
  }),
  id: Type.Optional(
    Type.String({ description: "An existing memory's id, to correct it instead of adding one." }),
  ),
});

const FORGET_PARAMETERS = Type.Object({
  id: Type.String({ description: "The id of the memory to drop." }),
  reason: Type.Optional(Type.String({ description: "Why it is wrong or no longer useful." })),
});

const RECALL_PARAMETERS = Type.Object({
  query: Type.String({ description: "Words to look for in the handbook and your memory." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
});

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

/**
 * The tools an agent uses on its own private memory: `remember`, `forget` and `recall`. Each write
 * records the task it came from. Agents cannot write the handbook or another agent's memory; the
 * memory store refuses it whatever the tool is asked.
 */
export function createMemoryTools(input: {
  readonly memory: CompanyMemory;
  readonly agentId: string;
  readonly taskId?: string;
}): ToolDefinition[] {
  const { memory, agentId } = input;
  const scope = agentScope(agentId);
  const actor = { kind: "agent" as const, id: agentId };
  const origin = {
    kind: "agent" as const,
    ...(input.taskId === undefined ? {} : { ref: input.taskId }),
  };

  const remember = withAgentHarnessToolEffects(
    defineTool({
      name: "remember",
      label: "Remember",
      description:
        "Save something worth keeping between tasks to your private memory: a lesson, a decision, a fact about your work. Pass the id of an existing memory to correct it.",
      parameters: REMEMBER_PARAMETERS,
      async execute(_id: string, params: Static<typeof REMEMBER_PARAMETERS>) {
        const existing =
          params.id === undefined
            ? undefined
            : (await memory.read(scope)).entries.memory[params.id];
        const result = await memory.apply({
          scope,
          actor,
          origin,
          edits: [
            {
              action: existing === undefined ? "create" : "update",
              kind: "memory",
              ...(params.id === undefined ? {} : { id: params.id }),
              title: params.title,
              content: params.content,
            },
          ],
        });
        const edit = result.edits[0];
        if (edit === undefined || !edit.applied) {
          return { ...text(`Not saved: ${edit?.error ?? "unknown error"}.`), isError: true };
        }
        return text(`Saved as [${edit.id}].`);
      },
    }),
    {
      id: "memory.remember",
      label: "Remember",
      effects: ["memory.write"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    },
  );

  const forget = withAgentHarnessToolEffects(
    defineTool({
      name: "forget",
      label: "Forget",
      description: "Drop one of your memories that turned out wrong or no longer matters.",
      parameters: FORGET_PARAMETERS,
      async execute(_id: string, params: Static<typeof FORGET_PARAMETERS>) {
        const result = await memory.apply({
          scope,
          actor,
          origin: { ...origin, ...(params.reason === undefined ? {} : { note: params.reason }) },
          edits: [{ action: "delete", kind: "memory", id: params.id }],
        });
        const edit = result.edits[0];
        if (edit === undefined || !edit.applied) {
          return { ...text(`Not removed: ${edit?.error ?? "unknown error"}.`), isError: true };
        }
        return text(`Removed [${params.id}].`);
      },
    }),
    {
      id: "memory.forget",
      label: "Forget",
      effects: ["memory.write"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    },
  );

  const recall = withAgentHarnessToolEffects(
    defineTool({
      name: "recall",
      label: "Recall",
      description: "Search the company handbook and your private memory.",
      parameters: RECALL_PARAMETERS,
      async execute(_id: string, params: Static<typeof RECALL_PARAMETERS>) {
        const found = await memory.search(agentId, params.query, params.limit ?? 10);
        if (found.length === 0) {
          return text("Nothing matches.");
        }
        return text(
          found
            .map(
              (entry) =>
                `[${entry.id}] (${entry.scope === "company" ? "handbook" : "yours"}, ${entry.kind}) ${entry.title}\n${entry.content}`,
            )
            .join("\n\n"),
        );
      },
    }),
    {
      id: "memory.recall",
      label: "Recall",
      effects: ["memory.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    },
  );

  return [remember, forget, recall] as ToolDefinition[];
}
