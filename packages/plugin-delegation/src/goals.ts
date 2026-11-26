import type {
  Awaitable,
  CanonicalEvent,
  GoalCheck,
  GoalEvidence,
  GoalJudge,
  GoalValidationReport,
  RunStoreContract,
  SealedGoal,
} from "@generic-ai/sdk";
import {
  GoalSpecError,
  goalTraceFromCanonicalEvents,
  parseActorDirectives,
  parseGoalSpec,
  runGoalValidators,
  sealGoal,
} from "@generic-ai/sdk";

import type { PersistentAgentRecord } from "./agents.js";
import type { AgentTaskGoal, AgentTaskGoalReport, AgentTaskRecord } from "./tasks.js";

/**
 * Goal gating for delegated tasks (roadmap R24 wired into R9).
 *
 * A task whose goal carries a `spec` only succeeds when the SDK validator
 * runner reports `COMPLETE`. The goal is sealed and fingerprinted when the
 * task is created and stored on the task record; every check re-seals it and
 * compares fingerprints, so a goal changed after submission is refused.
 * Judges and checks are host code registered here, never named by the agent.
 */
export interface TaskGoalOptions {
  /** Rubric judges by `judgeRef`; a bare function registers as `default`. */
  readonly judges?: GoalJudge | Readonly<Record<string, GoalJudge>>;
  /** Deterministic checks by `checkRef` (tests, CLIs, scripts). */
  readonly checks?: Readonly<Record<string, GoalCheck>>;
  readonly defaultTimeoutMs?: number;
  /** Extra evidence for a task turn, such as metrics or artifacts the host collected. */
  readonly evidence?: (input: TaskGoalEvidenceInput) => Awaitable<Partial<GoalEvidence>>;
}

export interface TaskGoalEvidenceInput {
  readonly task: AgentTaskRecord;
  readonly agent: PersistentAgentRecord;
  readonly outputText: string;
  /** Harness runs that executed this turn. */
  readonly turnRunIds: readonly string[];
}

/** Seals a task goal's spec and records its fingerprint. Throws `GoalSpecError` on an invalid spec. */
export function prepareTaskGoal(goal: AgentTaskGoal | undefined): AgentTaskGoal | undefined {
  if (goal?.spec === undefined) {
    return goal;
  }
  const sealed = sealGoal(goal.spec);
  return {
    ...goal,
    spec: sealed.spec,
    fingerprint: sealed.fingerprint,
    ...(goal.definitionOfDone === undefined && sealed.spec.definitionOfDone.length > 0
      ? { definitionOfDone: sealed.spec.definitionOfDone.join("\n") }
      : {}),
  };
}

/** Re-seals a stored goal and checks it still matches the fingerprint taken at creation. */
export function sealStoredGoal(goal: AgentTaskGoal | undefined): SealedGoal | undefined {
  if (goal?.spec === undefined) {
    return undefined;
  }
  const sealed = sealGoal(goal.spec);
  if (goal.fingerprint !== undefined && goal.fingerprint !== sealed.fingerprint) {
    throw new Error("The task's goal changed after it was created; refusing to validate it.");
  }
  return sealed;
}

/** Validates an untrusted goal spec from an agent's delegation. Returns an error message or the spec. */
export function readDelegatedGoalSpec(
  value: unknown,
): { readonly spec: AgentTaskGoal["spec"] } | { readonly error: string } {
  const parsed = parseGoalSpec(value);
  if (!parsed.ok) {
    return { error: new GoalSpecError(parsed.issues).message };
  }
  return { spec: parsed.value };
}

export async function collectGoalEvidence(
  runStore: Pick<RunStoreContract, "readEvents">,
  input: TaskGoalEvidenceInput,
  extra?: TaskGoalOptions["evidence"],
): Promise<GoalEvidence> {
  const events: CanonicalEvent[] = [];
  for (const runId of input.turnRunIds) {
    events.push(...(await runStore.readEvents(runId)));
  }
  const structured = parseActorDirectives(input.outputText).data;
  const additional = (await extra?.(input)) ?? {};
  return {
    outputText: input.outputText,
    ...(structured === undefined ? {} : { output: structured }),
    trace: goalTraceFromCanonicalEvents(events),
    ...additional,
  };
}

export async function validateTaskGoal(
  sealed: SealedGoal,
  evidence: GoalEvidence,
  options: TaskGoalOptions & { readonly signal?: AbortSignal; readonly fingerprint?: string },
): Promise<GoalValidationReport> {
  return runGoalValidators(sealed, evidence, {
    ...(options.judges === undefined ? {} : { judges: options.judges }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fingerprint === undefined ? {} : { expectedFingerprint: options.fingerprint }),
  });
}

export function summarizeGoalReport(report: GoalValidationReport): AgentTaskGoalReport {
  return {
    status: report.status,
    goalId: report.goalId,
    fingerprint: report.goalFingerprint,
    required: report.summary.required,
    passed: report.summary.passed,
    failed: report.summary.failed,
    errored: report.summary.errored,
    feedback: report.feedback,
    evaluatedAt: report.evaluatedAt,
  };
}
