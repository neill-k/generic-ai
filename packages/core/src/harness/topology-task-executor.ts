import type {
  AgentTaskExecutionInput,
  AgentTaskExecutor,
  JsonValue,
  ProtocolActionOutcome,
  RunStoreContract,
} from "@generic-ai/sdk";

import {
  type HarnessTopologyRunResult,
  type RunHarnessTopologyOptions,
  runHarnessTopology,
  type TopologyActorRunner,
} from "./topology-runner.js";

/**
 * Run a protocol topology (pipeline, verifier-loop, hierarchy, squad) as one
 * turn of a durable agent task, so a persistent agent can use a fixed team
 * workflow for its work while the cross-run delegation cascade handles the
 * org chart around it.
 *
 * With a `checkpoints` run store, every action outcome is saved as it
 * completes. If the process dies mid-topology, or the turn fails and the
 * queue retries it, the next attempt of the same task turn keeps the actions
 * that already succeeded and runs only the rest.
 */
export interface CreateTopologyTaskExecutorOptions
  extends Omit<
    RunHarnessTopologyOptions,
    "instruction" | "runId" | "signal" | "runner" | "resumeFrom"
  > {
  /** Runs each actor. Use `createRunner` instead to build one per task turn. */
  readonly runner?: TopologyActorRunner;
  readonly createRunner?: (input: AgentTaskExecutionInput) => TopologyActorRunner;
  /** Saves action outcomes so an interrupted turn resumes instead of restarting. */
  readonly checkpoints?: Pick<RunStoreContract, "getSession" | "saveSession">;
  readonly onResult?: (
    result: HarnessTopologyRunResult,
    input: AgentTaskExecutionInput,
  ) => void | Promise<void>;
}

export function topologyCheckpointSessionId(input: AgentTaskExecutionInput): string {
  const round = input.metadata?.["round"];
  return `${input.taskId}:topology:${typeof round === "number" ? round : 0}`;
}

export function createTopologyTaskExecutor(
  options: CreateTopologyTaskExecutorOptions,
): AgentTaskExecutor {
  const { runner, createRunner, checkpoints, onResult, ...topology } = options;
  if (runner === undefined && createRunner === undefined) {
    throw new TypeError("createTopologyTaskExecutor needs a runner or createRunner.");
  }
  return async (input) => {
    const sessionId = topologyCheckpointSessionId(input);
    let resumeFrom: ProtocolActionOutcome[] = [];
    let version: number | undefined;
    if (checkpoints !== undefined) {
      const saved = await checkpoints.getSession(sessionId);
      if (saved !== undefined) {
        version = saved.version;
        const state = saved.state as { readonly outcomes?: unknown } | null | undefined;
        if (state !== null && typeof state === "object" && Array.isArray(state.outcomes)) {
          // Keep what succeeded; failed or skipped actions run again.
          resumeFrom = (state.outcomes as ProtocolActionOutcome[]).filter(
            (outcome) => outcome.status === "succeeded",
          );
        }
      }
    }
    const outcomes = [...resumeFrom];
    const checkpoint = async (status: "active" | "succeeded" | "failed") => {
      if (checkpoints === undefined) {
        return;
      }
      const saved = await checkpoints.saveSession({
        sessionId,
        runId: input.taskId,
        agentId: input.agentId,
        status,
        state: { outcomes: JSON.parse(JSON.stringify(outcomes)) as JsonValue },
        metadata: { attemptRunId: input.attemptRunId },
        ...(version === undefined ? { expectedVersion: 0 } : { expectedVersion: version }),
      });
      version = saved.version;
    };

    const result = await runHarnessTopology({
      ...topology,
      instruction: input.prompt,
      runId: input.attemptRunId,
      runner: createRunner?.(input) ?? (runner as TopologyActorRunner),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(resumeFrom.length === 0 ? {} : { resumeFrom }),
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
        await checkpoint("active");
        await topology.onOutcome?.(outcome);
      },
    });
    if (result.status === "succeeded" || result.status === "failed") {
      await checkpoint(result.status);
    }
    await onResult?.(result, input);
    return {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      outputText: result.outputText,
      runIds: [result.runId],
      ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
      ...(result.status === "blocked" || result.status === "cancelled" ? { retryable: false } : {}),
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      metadata: {
        protocol: result.protocol,
        steps: result.steps,
        topologyStatus: result.status,
      },
    };
  };
}
