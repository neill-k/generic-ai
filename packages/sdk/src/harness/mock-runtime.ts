import type {
  AgentHarnessAdapter,
  AgentHarnessAdapterRunContext,
  AgentHarnessRunInput,
  AgentHarnessRunResult,
} from "./types.js";

export interface MockRuntimeAdapterOptions<TCapabilities = unknown, TOutput = string> {
  readonly id?: string;
  readonly run?: (
    input: AgentHarnessRunInput<TCapabilities>,
    context: AgentHarnessAdapterRunContext,
  ) => Promise<AgentHarnessRunResult<TOutput>> | AgentHarnessRunResult<TOutput>;
}

export function createMockRuntimeAdapter<TCapabilities = unknown, TOutput = string>(
  options: MockRuntimeAdapterOptions<TCapabilities, TOutput> = {},
): AgentHarnessAdapter<TCapabilities, TOutput> {
  return {
    id: options.id ?? "mock.runtime.adapter",
    kind: "external",
    run: async (input, context) => {
      const result = await options.run?.(input, context);
      if (result !== undefined) {
        return result;
      }

      const runId = input.runId ?? "mock-run";
      const now = new Date().toISOString();
      const output = "mock-runtime-output" as TOutput;

      return {
        harnessId: input.harness.id,
        adapter: "external",
        status: "succeeded",
        outputText: String(output),
        output,
        envelope: {
          kind: "run-envelope",
          runId,
          rootScopeId: input.rootScopeId ?? "scope/root",
          rootAgentId: input.rootAgentId ?? input.harness.primaryAgent ?? "root",
          mode: "sync",
          status: "succeeded",
          timestamps: {
            createdAt: now,
            startedAt: now,
            completedAt: now,
          },
          eventStream: {
            kind: "event-stream-reference",
            streamId: runId,
          },
        },
        events: [],
        projections: [],
        artifacts: [],
        policyDecisions: [],
        hookDecisions: [],
      } satisfies AgentHarnessRunResult<TOutput>;
    },
  };
}
