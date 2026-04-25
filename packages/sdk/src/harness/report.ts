import type {
  BenchmarkReport,
  BenchmarkReportCandidate,
  BenchmarkSpec,
  BenchmarkTrialResult,
  MetricDefinition,
  MetricValue,
  MissionSpec,
  RecommendationBoundary,
} from "./types.js";

type ComparableMetricDirection = Exclude<MetricDefinition["direction"], "informational">;

const DEFAULT_LOWER_IS_BETTER_METRICS = new Set([
  "cost_usd",
  "handoff_count",
  "latency",
  "latency_ms",
  "policy_violations",
  "rework_count",
  "rework_rate",
  "wall_time",
]);

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function aggregateMetric(
  metricId: string,
  results: readonly BenchmarkTrialResult[],
): MetricValue | undefined {
  const values = results
    .map((result) => result.metrics.find((metric) => metric.metricId === metricId)?.value)
    .filter((value): value is number => value !== undefined);
  const averageValue = average(values);
  if (averageValue === undefined) {
    return undefined;
  }

  const evidenceRefs = results.flatMap((result) =>
    result.metrics
      .filter((metric) => metric.metricId === metricId)
      .flatMap((metric) => metric.evidenceRefs),
  );

  return Object.freeze({
    metricId,
    value: averageValue,
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
  });
}

function metricDirection(
  benchmark: BenchmarkSpec,
  metricId: string,
): MetricDefinition["direction"] {
  const configured = benchmark.metricDefinitions?.find(
    (metric) => metric.id === metricId,
  )?.direction;
  if (configured !== undefined) {
    return configured;
  }

  return DEFAULT_LOWER_IS_BETTER_METRICS.has(metricId) ? "lower_is_better" : "higher_is_better";
}

function bestMetricValue(
  values: readonly number[],
  direction: ComparableMetricDirection,
): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return direction === "lower_is_better" ? Math.min(...values) : Math.max(...values);
}

function recommendationFor(input: {
  readonly benchmark: BenchmarkSpec;
  readonly trialCount: number;
  readonly traceCompleteness: number;
  readonly primaryMetric: MetricValue | undefined;
  readonly primaryMetricDirection: MetricDefinition["direction"];
  readonly bestPrimaryMetricValue: number | undefined;
}): RecommendationBoundary {
  const minimumTrials = input.benchmark.validity?.minimumTrialsForRecommendation ?? 3;
  const singleRunOverride =
    input.benchmark.validity?.allowSingleRunRecommendation === true &&
    input.benchmark.trials.count === 1 &&
    input.trialCount === 1;

  if (input.trialCount === 0 || (input.trialCount < minimumTrials && !singleRunOverride)) {
    return "insufficient_evidence";
  }

  if (input.benchmark.validity?.requireTraceCompleteness === true && input.traceCompleteness < 1) {
    return "insufficient_evidence";
  }

  if (
    input.primaryMetric === undefined ||
    input.bestPrimaryMetricValue === undefined ||
    input.primaryMetricDirection === "informational"
  ) {
    return "insufficient_evidence";
  }

  if (input.primaryMetricDirection === "lower_is_better") {
    return input.primaryMetric.value <= input.bestPrimaryMetricValue
      ? "recommended"
      : "not_recommended";
  }

  if (input.primaryMetric.value >= input.bestPrimaryMetricValue) {
    return "recommended";
  }

  return "not_recommended";
}

function candidateReport(input: {
  readonly benchmark: BenchmarkSpec;
  readonly candidateId: string;
  readonly harnessId: string;
  readonly results: readonly BenchmarkTrialResult[];
  readonly primaryMetricDirection: MetricDefinition["direction"];
  readonly bestPrimaryMetricValue: number | undefined;
}): BenchmarkReportCandidate {
  const primaryMetric = aggregateMetric(input.benchmark.primaryMetric, input.results);
  const guardrails = (input.benchmark.guardrailMetrics ?? [])
    .map((metricId) => aggregateMetric(metricId, input.results))
    .filter((metric): metric is MetricValue => metric !== undefined);
  const traceCompleteness =
    average(input.results.map((result) => result.diagnostics.completeness)) ?? 0;
  const recommendation = recommendationFor({
    benchmark: input.benchmark,
    trialCount: input.results.length,
    traceCompleteness,
    primaryMetric,
    primaryMetricDirection: input.primaryMetricDirection,
    bestPrimaryMetricValue: input.bestPrimaryMetricValue,
  });
  const rationale = [
    primaryMetric === undefined
      ? `${input.benchmark.primaryMetric} average: missing`
      : `${input.benchmark.primaryMetric} average: ${primaryMetric.value}`,
    `trace completeness: ${traceCompleteness}`,
    `trials: ${input.results.length}`,
  ];

  return Object.freeze({
    candidateId: input.candidateId,
    harnessId: input.harnessId,
    trialCount: input.results.length,
    scorecard: Object.freeze([
      ...(primaryMetric === undefined ? [] : [primaryMetric]),
      ...guardrails,
    ]),
    traceCompleteness,
    recommendation,
    rationale: Object.freeze(rationale),
  });
}

export function createBenchmarkReport(input: {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly generatedAt: string;
  readonly results: readonly BenchmarkTrialResult[];
}): BenchmarkReport {
  const byCandidate = new Map<string, BenchmarkTrialResult[]>();
  for (const result of input.results) {
    byCandidate.set(result.candidateId, [...(byCandidate.get(result.candidateId) ?? []), result]);
  }

  const primaryMetricDirection = metricDirection(input.benchmark, input.benchmark.primaryMetric);
  const primaryValues = [...byCandidate.values()]
    .map((results) => aggregateMetric(input.benchmark.primaryMetric, results)?.value)
    .filter((value): value is number => value !== undefined);
  const bestPrimaryMetricValue =
    primaryMetricDirection === "informational"
      ? undefined
      : bestMetricValue(primaryValues, primaryMetricDirection);
  const candidates = input.benchmark.candidates.map((candidate) =>
    candidateReport({
      benchmark: input.benchmark,
      candidateId: candidate.id,
      harnessId: byCandidate.get(candidate.id)?.[0]?.harnessId ?? candidate.harnessRef,
      results: byCandidate.get(candidate.id) ?? [],
      primaryMetricDirection,
      bestPrimaryMetricValue,
    }),
  );
  const insufficientEvidence = candidates
    .filter((candidate) => candidate.recommendation === "insufficient_evidence")
    .map((candidate) => `${candidate.candidateId}: ${candidate.rationale.join("; ")}`);
  const traceEventCount = input.results.reduce(
    (total, result) => total + result.traceEvents.length,
    0,
  );
  const artifactCount = input.results.reduce((total, result) => total + result.artifacts.length, 0);
  const metricCount = input.results.reduce((total, result) => total + result.metrics.length, 0);

  return Object.freeze({
    kind: "generic-ai.benchmark-report",
    schemaVersion: input.benchmark.schemaVersion,
    benchmarkId: input.benchmark.id,
    missionId: input.mission.id,
    generatedAt: input.generatedAt,
    hypothesis: input.benchmark.hypothesis,
    primaryMetric: input.benchmark.primaryMetric,
    observations: Object.freeze([
      `Collected ${traceEventCount} trace events across ${input.results.length} trial runs.`,
    ]),
    inferences: Object.freeze(
      insufficientEvidence.length > 0
        ? ["At least one candidate lacks enough evidence for a confident recommendation."]
        : ["Trial evidence is sufficient for the configured recommendation threshold."],
    ),
    recommendations: Object.freeze(
      candidates.map((candidate) => `${candidate.candidateId}: ${candidate.recommendation}`),
    ),
    candidates: Object.freeze(candidates),
    evidence: Object.freeze({
      traceEventCount,
      artifactCount,
      metricCount,
    }),
    insufficientEvidence: Object.freeze(insufficientEvidence),
  });
}

export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# Benchmark Report: ${report.benchmarkId}`,
    "",
    `Mission: ${report.missionId}`,
    `Generated: ${report.generatedAt}`,
    `Primary metric: ${report.primaryMetric}`,
    "",
    "## Observations",
    "",
    ...report.observations.map((item) => `- ${item}`),
    "",
    "## Inferences",
    "",
    ...report.inferences.map((item) => `- ${item}`),
    "",
    "## Recommendations",
    "",
    ...report.recommendations.map((item) => `- ${item}`),
    "",
    "## Candidates",
    "",
    "| Candidate | Harness | Trials | Trace completeness | Recommendation |",
    "| --- | --- | ---: | ---: | --- |",
    ...report.candidates.map(
      (candidate) =>
        `| ${candidate.candidateId} | ${candidate.harnessId} | ${candidate.trialCount} | ${candidate.traceCompleteness} | ${candidate.recommendation} |`,
    ),
    "",
  ];

  if (report.insufficientEvidence.length > 0) {
    lines.push(
      "## Insufficient Evidence",
      "",
      ...report.insufficientEvidence.map((item) => `- ${item}`),
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}
