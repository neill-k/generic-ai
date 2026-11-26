import type {
  BenchmarkReportCandidate,
  BenchmarkTrialResult,
  BenchmarkUsageReportSummary,
} from "./types.js";

function count(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function amount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Summarize trial spend. Returns undefined when no trial recorded usage, so reports without usage
 * evidence stay unchanged. Tokens of every observed trial count toward the per-goal figure, so
 * failed attempts make `tokensPerCompletedGoal` worse.
 */
export function benchmarkUsageSummary(
  results: readonly BenchmarkTrialResult[],
): BenchmarkUsageReportSummary | undefined {
  const observed = results.filter((result) => result.usage !== undefined);
  if (observed.length === 0) {
    return undefined;
  }
  let totalTokens = 0;
  let totalCostUsd = 0;
  let costSamples = 0;
  let goalsAttempted = 0;
  let goalsCompleted = 0;
  let budgetStops = 0;
  for (const result of observed) {
    const usage = result.usage;
    if (usage === undefined) {
      continue;
    }
    totalTokens += count(usage.totalTokens, 0);
    const cost = amount(usage.costUsd);
    if (cost !== undefined) {
      totalCostUsd += cost;
      costSamples += 1;
    }
    const attempted = count(usage.goalsAttempted, 1);
    goalsAttempted += attempted;
    goalsCompleted += Math.min(
      attempted,
      count(usage.goalsCompleted, result.outcome?.status === "passed" ? 1 : 0),
    );
    if (usage.budgetStopped === true) {
      budgetStops += 1;
    }
  }
  const warnings = [
    ...(observed.length < results.length
      ? [`Usage missing for ${results.length - observed.length} of ${results.length} trial(s).`]
      : []),
    ...(costSamples > 0 && costSamples < observed.length
      ? [`Dollar cost missing for ${observed.length - costSamples} trial(s) with usage.`]
      : []),
    ...(budgetStops > 0 ? [`${budgetStops} trial(s) were stopped by a token or dollar cap.`] : []),
  ];
  const totalCost = costSamples === 0 ? null : totalCostUsd;
  return Object.freeze({
    observedTrialCount: observed.length,
    trialCount: results.length,
    totalTokens,
    totalCostUsd: totalCost,
    goalsAttempted,
    goalsCompleted,
    tokensPerCompletedGoal: goalsCompleted === 0 ? null : totalTokens / goalsCompleted,
    costPerCompletedGoalUsd:
      goalsCompleted === 0 || totalCost === null ? null : totalCost / goalsCompleted,
    budgetStops,
    warnings: Object.freeze(warnings),
  });
}

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function formatBenchmarkUsage(usage: BenchmarkUsageReportSummary): string {
  return `tokens_per_completed_goal=${formatNumber(usage.tokensPerCompletedGoal)}, goals=${usage.goalsCompleted}/${usage.goalsAttempted}, tokens=${usage.totalTokens}, cost_usd=${formatNumber(usage.totalCostUsd, 4)}`;
}

/** Markdown lines for the usage section, or none when no candidate recorded usage. */
export function renderBenchmarkUsageMarkdown(
  candidates: readonly BenchmarkReportCandidate[],
): readonly string[] {
  const withUsage = candidates.filter(
    (candidate): candidate is BenchmarkReportCandidate & { usage: BenchmarkUsageReportSummary } =>
      candidate.usage !== undefined,
  );
  if (withUsage.length === 0) {
    return [];
  }
  const warnings = withUsage.flatMap((candidate) =>
    candidate.usage.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
  );
  return [
    "## Usage and Cost",
    "",
    "Headline: tokens per completed goal (all tokens spent, including on failed goals, divided by goals completed). Lower is better.",
    "",
    "| Candidate | Tokens / completed goal | Cost USD / completed goal | Goals completed | Total tokens | Total cost USD | Budget stops | Trials with usage |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...withUsage.map((candidate) => {
      const usage = candidate.usage;
      return `| ${candidate.candidateId} | ${formatNumber(usage.tokensPerCompletedGoal)} | ${formatNumber(
        usage.costPerCompletedGoalUsd,
        4,
      )} | ${usage.goalsCompleted}/${usage.goalsAttempted} | ${usage.totalTokens} | ${formatNumber(
        usage.totalCostUsd,
        4,
      )} | ${usage.budgetStops} | ${usage.observedTrialCount}/${usage.trialCount} |`;
    }),
    "",
    ...(warnings.length === 0
      ? []
      : ["Usage warnings:", "", ...warnings.map((warning) => `- ${warning}`), ""]),
  ];
}
