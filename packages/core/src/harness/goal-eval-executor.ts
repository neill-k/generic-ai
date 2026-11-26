import type {
  CompiledHarness,
  GoalEvalAttempt,
  GoalEvalExecution,
  GoalEvalExecutor,
  GoalTraceEntry,
  ProtocolActionOutcome,
  ProtocolPlugin,
} from "@generic-ai/sdk";
import {
  type HarnessTopologyRunResult,
  runHarnessTopology,
  type TopologyActorRunner,
} from "./topology-runner.js";

export interface CreateTopologyGoalEvalExecutorOptions {
  /** The compiled harness whose topology each attempt runs. */
  readonly compiled: CompiledHarness;
  /**
   * Runs one actor. Called per attempt so every attempt gets fresh state, for
   * example `createAdapterTopologyActorRunner` over the native or pi adapter.
   */
  readonly createRunner: (
    attempt: GoalEvalAttempt,
  ) => TopologyActorRunner | Promise<TopologyActorRunner>;
  readonly protocol?: string;
  readonly protocols?: readonly ProtocolPlugin[];
  readonly maxSteps?: number;
  readonly maxConcurrency?: number;
  readonly maxAttempts?: number;
  /** Per-attempt deadline in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Trace entries for the topology's own steps, so `trace` validators can
 * require that, say, a verifier actor ran after the builder.
 */
export function goalTraceFromTopologyOutcomes(
  outcomes: readonly ProtocolActionOutcome[],
): GoalTraceEntry[] {
  return outcomes.flatMap((outcome) =>
    outcome.actorRef === undefined
      ? []
      : [
          Object.freeze({
            type: outcome.status === "failed" ? "actor.failed" : "actor.completed",
            roleId: outcome.actorRef,
            args: Object.freeze({
              kind: outcome.kind,
              step: outcome.step,
              attempt: outcome.attempt,
              ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }),
            }),
            isError: outcome.status === "failed",
          }),
        ],
  );
}

/** Maps a topology run onto the record a goal eval scores. */
export function goalEvalExecutionFromTopology(result: HarnessTopologyRunResult): GoalEvalExecution {
  return {
    runId: result.runId,
    runStatus: result.status,
    ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
    outputText: result.outputText,
    events: result.events,
    trace: goalTraceFromTopologyOutcomes(result.outcomes),
    ...(result.costUsd === undefined
      ? {}
      : { metrics: Object.freeze({ "topology.costUsd": result.costUsd }) }),
  };
}

/**
 * A goal eval executor that runs each attempt through the harness's real
 * protocol topology (pipeline, verifier-loop, hierarchy, squad), not a single
 * prompt to a single model.
 */
export function createTopologyGoalEvalExecutor(
  options: CreateTopologyGoalEvalExecutorOptions,
): GoalEvalExecutor {
  return async (attempt) => {
    const runner = await options.createRunner(attempt);
    const result = await runHarnessTopology({
      compiled: options.compiled,
      instruction: attempt.prompt,
      runner,
      runId: `${attempt.suite.id}:${attempt.trialId}`,
      ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
      ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.timeoutMs === undefined
        ? {}
        : { deadline: new Date(Date.now() + options.timeoutMs) }),
      ...(attempt.signal === undefined ? {} : { signal: attempt.signal }),
    });
    return goalEvalExecutionFromTopology(result);
  };
}
