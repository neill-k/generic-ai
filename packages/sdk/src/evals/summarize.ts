import type { GoalValidatorKind } from "../goals/types.js";
import { estimatePassHatK } from "./pass-k.js";
import { goalEvalTrialCount, sealGoalEvalCase } from "./suite.js";
import {
  GOAL_EVAL_SCHEMA_VERSION,
  type GoalEvalCaseSpec,
  type GoalEvalCaseSummary,
  type GoalEvalCheckScore,
  type GoalEvalCheckScores,
  type GoalEvalEfficiency,
  type GoalEvalFinding,
  type GoalEvalGateResult,
  type GoalEvalReport,
  type GoalEvalSuiteSpec,
  type GoalEvalTrialScore,
} from "./types.js";

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function mergeCheckScores(scores: readonly GoalEvalCheckScores[]): GoalEvalCheckScores {
  const merged = new Map<GoalValidatorKind, { total: number; passed: number; weighted: number }>();
  for (const score of scores) {
    for (const [kind, value] of Object.entries(score) as [
      GoalValidatorKind,
      GoalEvalCheckScore,
    ][]) {
      const entry = merged.get(kind) ?? { total: 0, passed: 0, weighted: 0 };
      entry.total += value.total;
      entry.passed += value.passed;
      entry.weighted += value.score * value.total;
      merged.set(kind, entry);
    }
  }
  const result: Partial<Record<GoalValidatorKind, GoalEvalCheckScore>> = {};
  for (const [kind, entry] of merged) {
    result[kind] = Object.freeze({
      total: entry.total,
      passed: entry.passed,
      score: rate(entry.weighted, entry.total),
    });
  }
  return Object.freeze(result);
}

function efficiency(results: readonly GoalEvalTrialScore[]): GoalEvalEfficiency {
  const withUsage = results.filter((result) => result.usage !== undefined);
  const totalTokens = withUsage.reduce((sum, result) => sum + (result.usage?.totalTokens ?? 0), 0);
  const priced = withUsage.filter((result) => result.usage?.costUsd !== undefined);
  const totalCostUsd =
    priced.length === 0
      ? null
      : priced.reduce((sum, result) => sum + (result.usage?.costUsd ?? 0), 0);
  const completedGoals = results.filter((result) => result.passed).length;
  return Object.freeze({
    totalTokens,
    totalCostUsd,
    completedGoals,
    tokensPerCompletedGoal:
      completedGoals === 0 || withUsage.length === 0 ? null : totalTokens / completedGoals,
    costPerCompletedGoalUsd:
      completedGoals === 0 || totalCostUsd === null ? null : totalCostUsd / completedGoals,
    budgetStops: results.filter((result) => result.usage?.budgetStopped === true).length,
    attemptsWithoutUsage: results.length - withUsage.length,
  });
}

function resultMessage(
  result: GoalEvalTrialScore,
  validatorId: string,
): { message: string; fix?: string; kind: GoalEvalFinding["kind"] } | undefined {
  const holdout = validatorId.startsWith("holdout:");
  const id = holdout ? validatorId.slice("holdout:".length) : validatorId;
  const report = holdout ? result.holdoutReport : result.report;
  const match = report?.results.find((entry) => entry.validatorId === id);
  if (match === undefined) {
    return undefined;
  }
  return {
    message: match.message,
    ...(match.fix === undefined ? {} : { fix: match.fix }),
    kind: holdout ? "holdout" : match.kind,
  };
}

function caseFindings(caseId: string, results: readonly GoalEvalTrialScore[]): GoalEvalFinding[] {
  const groups = new Map<
    string,
    { kind: GoalEvalFinding["kind"]; messages: Map<string, number>; fix?: string; failures: number }
  >();
  const note = (id: string, kind: GoalEvalFinding["kind"], message: string, fix?: string) => {
    const group = groups.get(id) ?? { kind, messages: new Map<string, number>(), failures: 0 };
    group.failures += 1;
    group.messages.set(message, (group.messages.get(message) ?? 0) + 1);
    if (fix !== undefined && group.fix === undefined) {
      group.fix = fix;
    }
    groups.set(id, group);
  };
  for (const result of results) {
    // A run that did not finish fails its checks as a consequence; report the
    // root cause once instead of every check it took down with it.
    const runFinished = result.runStatus === "succeeded";
    if (!runFinished) {
      note(
        `run.${result.runStatus}`,
        "run",
        result.failureMessage ?? `The run ended ${result.runStatus}.`,
      );
    }
    for (const validatorId of runFinished ? result.failedValidators : []) {
      const detail = resultMessage(result, validatorId);
      if (detail !== undefined) {
        note(validatorId, detail.kind, detail.message, detail.fix);
      }
    }
    for (const finding of result.integrity) {
      note(`integrity.${finding.code}`, "integrity", finding.message);
    }
  }
  return [...groups.entries()].map(([validatorId, group]) => {
    const [message] = [...group.messages.entries()].sort(
      (left, right) => right[1] - left[1],
    )[0] ?? [""];
    return Object.freeze({
      caseId,
      validatorId,
      kind: group.kind,
      failures: group.failures,
      trials: results.length,
      message,
      ...(group.fix === undefined ? {} : { fix: group.fix }),
    });
  });
}

function summarizeCase(
  suite: GoalEvalSuiteSpec,
  caseSpec: GoalEvalCaseSpec,
  results: readonly GoalEvalTrialScore[],
): GoalEvalCaseSummary {
  const sealed = sealGoalEvalCase(caseSpec);
  const passed = results.filter((result) => result.passed).length;
  const k = suite.trials?.passK ?? goalEvalTrialCount(suite, caseSpec);
  const durations = results.flatMap((result) =>
    result.durationMs === undefined ? [] : [result.durationMs],
  );
  return Object.freeze({
    caseId: caseSpec.id,
    ...(caseSpec.title === undefined ? {} : { title: caseSpec.title }),
    goalId: caseSpec.goal.id,
    goalFingerprint: sealed.goal.fingerprint,
    trials: results.length,
    passed,
    passRate: rate(passed, results.length),
    passK: Object.freeze({
      k,
      passCount: passed,
      trialCount: results.length,
      value: estimatePassHatK(passed, results.length, k),
    }),
    checks: mergeCheckScores(results.map((result) => result.checks)),
    integrityViolations: results.reduce((sum, result) => sum + result.integrity.length, 0),
    holdoutRegressions: results.filter((result) => result.goalComplete && !result.holdoutComplete)
      .length,
    efficiency: efficiency(results),
    meanDurationMs:
      durations.length === 0
        ? null
        : durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
  });
}

function evaluateGate(input: {
  readonly suite: GoalEvalSuiteSpec;
  readonly cases: readonly GoalEvalCaseSummary[];
  readonly passRate: number;
  readonly integrityViolations: number;
  readonly efficiency: GoalEvalEfficiency;
}): GoalEvalGateResult {
  const gate = input.suite.gate ?? {};
  const reasons: string[] = [];
  const minTrials = gate.minTrialsPerCase ?? 1;
  for (const summary of input.cases) {
    if (summary.trials < minTrials) {
      reasons.push(
        `Case "${summary.caseId}" ran ${summary.trials} attempt(s); the gate needs at least ${minTrials}.`,
      );
    }
  }
  const maxIntegrity = gate.maxIntegrityViolations ?? 0;
  if (input.integrityViolations > maxIntegrity) {
    reasons.push(
      `${input.integrityViolations} integrity violation(s); the gate allows ${maxIntegrity}.`,
    );
  }
  if (gate.minPassRate !== undefined && input.passRate < gate.minPassRate) {
    reasons.push(
      `Pass rate ${formatRate(input.passRate)} is below the gate's ${formatRate(gate.minPassRate)}.`,
    );
  }
  if (gate.minPassK !== undefined) {
    for (const summary of input.cases) {
      if (summary.passK.value < gate.minPassK) {
        reasons.push(
          `Case "${summary.caseId}" pass^${summary.passK.k} is ${summary.passK.value.toFixed(3)}; the gate needs ${gate.minPassK}.`,
        );
      }
    }
  }
  if (gate.maxTokensPerCompletedGoal !== undefined) {
    const value = input.efficiency.tokensPerCompletedGoal;
    if (value === null) {
      reasons.push(
        input.efficiency.completedGoals === 0
          ? "No goal was completed, so tokens per completed goal is undefined."
          : "No usage evidence, so tokens per completed goal cannot be checked.",
      );
    } else if (value > gate.maxTokensPerCompletedGoal) {
      reasons.push(
        `Tokens per completed goal ${Math.round(value)} exceeds the gate's ${gate.maxTokensPerCompletedGoal}.`,
      );
    }
  }
  if (gate.maxCostPerCompletedGoalUsd !== undefined) {
    const value = input.efficiency.costPerCompletedGoalUsd;
    if (value === null) {
      reasons.push("Cost per completed goal is unknown, so the cost gate cannot be checked.");
    } else if (value > gate.maxCostPerCompletedGoalUsd) {
      reasons.push(
        `Cost per completed goal $${value.toFixed(4)} exceeds the gate's $${gate.maxCostPerCompletedGoalUsd}.`,
      );
    }
  }
  return Object.freeze({ passed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export interface SummarizeGoalEvalOptions {
  readonly now?: () => Date;
}

/**
 * Rolls attempt scores up into a suite report: pass rate and pass^k per case,
 * per-check scores, integrity violations, tokens and dollars per completed
 * goal, ranked findings, and the gate verdict.
 */
export function summarizeGoalEval(
  suite: GoalEvalSuiteSpec,
  results: readonly GoalEvalTrialScore[],
  options: SummarizeGoalEvalOptions = {},
): GoalEvalReport {
  const knownCases = new Set(suite.cases.map((caseSpec) => caseSpec.id));
  const unknown = results.find((result) => !knownCases.has(result.caseId));
  if (unknown !== undefined) {
    throw new Error(`Eval result references unknown case "${unknown.caseId}".`);
  }
  const cases = suite.cases.map((caseSpec) =>
    summarizeCase(
      suite,
      caseSpec,
      results.filter((result) => result.caseId === caseSpec.id),
    ),
  );
  const passed = results.filter((result) => result.passed).length;
  const passRate = rate(passed, results.length);
  const integrityViolations = results.reduce((sum, result) => sum + result.integrity.length, 0);
  const suiteEfficiency = efficiency(results);
  const findings = suite.cases
    .flatMap((caseSpec) =>
      caseFindings(
        caseSpec.id,
        results.filter((result) => result.caseId === caseSpec.id),
      ),
    )
    .sort(
      (left, right) =>
        right.failures / right.trials - left.failures / left.trials ||
        right.failures - left.failures ||
        left.caseId.localeCompare(right.caseId) ||
        left.validatorId.localeCompare(right.validatorId),
    );

  return Object.freeze({
    kind: "generic-ai.goal-eval-report",
    schemaVersion: GOAL_EVAL_SCHEMA_VERSION,
    suiteId: suite.id,
    ...(suite.title === undefined ? {} : { title: suite.title }),
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    trials: results.length,
    passed,
    passRate,
    checks: mergeCheckScores(results.map((result) => result.checks)),
    integrityViolations,
    efficiency: suiteEfficiency,
    cases: Object.freeze(cases),
    findings: Object.freeze(findings),
    gate: evaluateGate({
      suite,
      cases,
      passRate,
      integrityViolations,
      efficiency: suiteEfficiency,
    }),
    results: Object.freeze([...results]),
  });
}
