import type { CanonicalEvent } from "../events/taxonomy.js";
import { PROTECTED_PATHS_VALIDATOR_ID, runGoalValidators } from "../goals/runner.js";
import { findPathAccesses, goalTraceFromCanonicalEvents } from "../goals/trace.js";
import type {
  GoalEvidence,
  GoalTraceEntry,
  GoalValidationReport,
  GoalValidatorKind,
  RunGoalValidatorsOptions,
  SealedGoal,
} from "../goals/types.js";
import { summarizeUsageEvents } from "../usage/ledger.js";
import { type SealedGoalEvalCase, sealGoalEvalCase } from "./suite.js";
import type {
  GoalEvalCaseSpec,
  GoalEvalCheckScore,
  GoalEvalCheckScores,
  GoalEvalIntegrityFinding,
  GoalEvalTrialRecord,
  GoalEvalTrialScore,
  GoalEvalUsage,
} from "./types.js";

/** Metric names the scorer derives from the trace, for numeric validators to use. */
export const GOAL_EVAL_DERIVED_METRICS = Object.freeze({
  totalTokens: "usage.totalTokens",
  costUsd: "usage.costUsd",
  responses: "usage.responses",
  durationMs: "run.durationMs",
  toolCalls: "trace.toolCalls",
  toolErrors: "trace.toolErrors",
});

export interface ScoreGoalEvalTrialOptions
  extends Pick<
    RunGoalValidatorsOptions,
    "judges" | "checks" | "signal" | "defaultTimeoutMs" | "now"
  > {
  /** Pre-sealed goals for the case. Sealed from the case spec when omitted. */
  readonly sealed?: SealedGoalEvalCase;
}

/**
 * Usage read from `usage.recorded` events. Returns undefined when the trace
 * has none, so a missing meter reads as "unknown", not "free".
 */
export function goalEvalUsageFromEvents(
  events: readonly CanonicalEvent[],
): GoalEvalUsage | undefined {
  const budgetStopped = events.some((event) => event.name === "usage.budget.exceeded");
  if (!events.some((event) => event.name === "usage.recorded")) {
    return budgetStopped ? { totalTokens: 0, budgetStopped } : undefined;
  }
  const totals = summarizeUsageEvents(events).totals;
  return Object.freeze({
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd: totals.costUsd,
    responses: totals.responses,
    ...(budgetStopped ? { budgetStopped } : {}),
  });
}

function isToolEntry(entry: GoalTraceEntry): boolean {
  return (
    entry.toolName !== undefined &&
    (entry.type.endsWith(".completed") || entry.type.endsWith(".failed"))
  );
}

function derivedMetrics(
  record: GoalEvalTrialRecord,
  trace: readonly GoalTraceEntry[],
  usage: GoalEvalUsage | undefined,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (usage !== undefined) {
    metrics[GOAL_EVAL_DERIVED_METRICS.totalTokens] = usage.totalTokens;
    if (usage.costUsd !== undefined) {
      metrics[GOAL_EVAL_DERIVED_METRICS.costUsd] = usage.costUsd;
    }
    if (usage.responses !== undefined) {
      metrics[GOAL_EVAL_DERIVED_METRICS.responses] = usage.responses;
    }
  }
  if (record.durationMs !== undefined) {
    metrics[GOAL_EVAL_DERIVED_METRICS.durationMs] = record.durationMs;
  }
  const toolEntries = trace.filter(isToolEntry);
  metrics[GOAL_EVAL_DERIVED_METRICS.toolCalls] = toolEntries.length;
  metrics[GOAL_EVAL_DERIVED_METRICS.toolErrors] = toolEntries.filter(
    (entry) => entry.isError === true,
  ).length;
  return metrics;
}

function stringData(event: CanonicalEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * In-run goal events about this goal. The harness reports in-run validation as
 * `goal.validated` / `goal.completed` (core or plugin namespaced) with
 * `data.goalId`, and optionally `data.goalFingerprint` and `data.status`.
 */
function goalEvents(events: readonly CanonicalEvent[], goalId: string): CanonicalEvent[] {
  return events.filter(
    (event) =>
      stringData(event, "goalId") === goalId &&
      (event.name.endsWith("goal.validated") ||
        event.name.endsWith("goal.completed") ||
        event.name.endsWith("goal.failed") ||
        stringData(event, "goalFingerprint") !== undefined),
  );
}

function integrityFindings(input: {
  readonly sealed: SealedGoalEvalCase;
  readonly report: GoalValidationReport;
  readonly trace: readonly GoalTraceEntry[];
  readonly events: readonly CanonicalEvent[];
}): GoalEvalIntegrityFinding[] {
  const { sealed, report, trace, events } = input;
  const findings: GoalEvalIntegrityFinding[] = [];

  const protectedResult = report.results.find(
    (result) => result.validatorId === PROTECTED_PATHS_VALIDATOR_ID,
  );
  if (protectedResult !== undefined && protectedResult.status !== "passed") {
    findings.push({
      code: "protected_path_write",
      message: protectedResult.message,
      evidenceRefs: [],
    });
  }

  const hiddenPaths = sealed.caseSpec.hiddenPaths ?? [];
  const accesses = findPathAccesses(trace, hiddenPaths);
  if (accesses.length > 0) {
    findings.push({
      code: "hidden_path_access",
      message: `The agent touched paths it must never see: ${accesses
        .map((access) => `${access.path} (${access.toolName})`)
        .join(", ")}.`,
      evidenceRefs: accesses.flatMap((access) =>
        access.eventId === undefined ? [] : [access.eventId],
      ),
    });
  }

  const relevant = goalEvents(events, sealed.goal.spec.id);
  const mismatched = relevant.filter((event) => {
    const fingerprint = stringData(event, "goalFingerprint");
    return fingerprint !== undefined && fingerprint !== sealed.goal.fingerprint;
  });
  if (mismatched.length > 0) {
    findings.push({
      code: "goal_fingerprint_mismatch",
      message: `The run validated goal "${sealed.goal.spec.id}" against a different definition than the one the eval sealed.`,
      evidenceRefs: mismatched.map((event) => event.eventId),
    });
  }

  if (!report.complete) {
    const claims = relevant.filter(
      (event) =>
        event.name.endsWith("goal.completed") || stringData(event, "status") === "COMPLETE",
    );
    if (claims.length > 0) {
      findings.push({
        code: "completion_claim_mismatch",
        message: `The run reported goal "${sealed.goal.spec.id}" COMPLETE, but re-running its validators on the same evidence says INCOMPLETE.`,
        evidenceRefs: claims.map((event) => event.eventId),
      });
    }
  }

  return findings;
}

function checkScores(reports: readonly GoalValidationReport[]): GoalEvalCheckScores {
  const totals = new Map<GoalValidatorKind, { total: number; passed: number; score: number }>();
  for (const report of reports) {
    for (const result of report.results) {
      if (result.validatorId === PROTECTED_PATHS_VALIDATOR_ID) {
        continue;
      }
      const entry = totals.get(result.kind) ?? { total: 0, passed: 0, score: 0 };
      const passed = result.status === "passed";
      entry.total += 1;
      entry.passed += passed ? 1 : 0;
      entry.score +=
        result.kind === "rubric" && result.score !== undefined ? result.score : passed ? 1 : 0;
      totals.set(result.kind, entry);
    }
  }
  const scores: Partial<Record<GoalValidatorKind, GoalEvalCheckScore>> = {};
  for (const [kind, entry] of totals) {
    scores[kind] = Object.freeze({
      total: entry.total,
      passed: entry.passed,
      score: entry.total === 0 ? 0 : entry.score / entry.total,
    });
  }
  return Object.freeze(scores);
}

function failedIds(report: GoalValidationReport | undefined, prefix = ""): string[] {
  return (report?.results ?? [])
    .filter((result) => result.required && result.status !== "passed")
    .map((result) => `${prefix}${result.validatorId}`);
}

/**
 * Scores one attempt from its trace. The visible goal's validators and the
 * case's held-out validators are re-run by the eval on the attempt's evidence;
 * in-run verdicts are never trusted, only cross-checked.
 */
export async function scoreGoalEvalTrial(
  caseSpec: GoalEvalCaseSpec,
  record: GoalEvalTrialRecord,
  options: ScoreGoalEvalTrialOptions = {},
): Promise<GoalEvalTrialScore> {
  const sealed = options.sealed ?? sealGoalEvalCase(caseSpec);
  const events = record.events ?? [];
  const trace = [...goalTraceFromCanonicalEvents(events), ...(record.trace ?? [])];
  const usage = record.usage ?? goalEvalUsageFromEvents(events);
  const metrics = {
    ...derivedMetrics(record, trace, usage),
    ...caseSpec.metrics,
    ...record.metrics,
  };
  const evidence: GoalEvidence = {
    ...(record.outputText === undefined ? {} : { outputText: record.outputText }),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.artifacts === undefined ? {} : { artifacts: record.artifacts }),
    metrics,
    trace,
  };
  const validatorOptions: RunGoalValidatorsOptions = {
    ...(options.judges === undefined ? {} : { judges: options.judges }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  const report = await runGoalValidators(sealed.goal, evidence, validatorOptions);
  const holdoutReport =
    sealed.holdout === undefined
      ? undefined
      : await runGoalValidators(sealed.holdout as SealedGoal, evidence, validatorOptions);
  const integrity = integrityFindings({ sealed, report, trace, events });
  const runStatus = record.runStatus ?? "succeeded";
  const holdoutComplete = holdoutReport?.complete ?? true;

  return Object.freeze({
    caseId: caseSpec.id,
    trialId: record.trialId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    passed:
      runStatus === "succeeded" && report.complete && holdoutComplete && integrity.length === 0,
    goalComplete: report.complete,
    holdoutComplete,
    runStatus,
    ...(record.failureMessage === undefined ? {} : { failureMessage: record.failureMessage }),
    checks: checkScores(holdoutReport === undefined ? [report] : [report, holdoutReport]),
    report,
    ...(holdoutReport === undefined ? {} : { holdoutReport }),
    integrity: Object.freeze(integrity.map((finding) => Object.freeze(finding))),
    failedValidators: Object.freeze([
      ...failedIds(report),
      ...failedIds(holdoutReport, "holdout:"),
    ]),
    ...(usage === undefined ? {} : { usage }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  });
}
