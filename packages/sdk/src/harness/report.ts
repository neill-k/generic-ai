import type {
  BenchmarkFailureSeverity,
  BenchmarkReliabilityProfile,
  BenchmarkReliabilitySummary,
  BenchmarkReport,
  BenchmarkReportCandidate,
  BenchmarkSpec,
  BenchmarkTrialResult,
  BenchmarkTrialOutcomeStatus,
  FaultInjectionObservation,
  FaultInjectionReportSummary,
  FaultInjectionSpec,
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
const DEFAULT_PASS_AT = Object.freeze([1, 3, 5]);
const FAILURE_SEVERITY_SCORE: Readonly<Record<BenchmarkFailureSeverity, number>> = Object.freeze({
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});
const FAILURE_SEVERITY_BY_SCORE: readonly (readonly [number, BenchmarkFailureSeverity])[] =
  Object.entries(FAILURE_SEVERITY_SCORE)
    .map(([severity, score]) => [score, severity as BenchmarkFailureSeverity] as const)
    .sort(([left], [right]) => right - left);

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

function metricSampleCount(metricId: string, results: readonly BenchmarkTrialResult[]): number {
  return results.filter((result) => result.metrics.some((metric) => metric.metricId === metricId))
    .length;
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

function metricValue(result: BenchmarkTrialResult, metricId: string): number | undefined {
  return result.metrics.find((metric) => metric.metricId === metricId)?.value;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function faultInjectionObservations(
  results: readonly BenchmarkTrialResult[],
): readonly FaultInjectionObservation[] {
  return Object.freeze(results.flatMap((result) => result.faultInjections ?? []));
}

function faultInjectionSummary(input: {
  readonly planned: readonly FaultInjectionSpec[];
  readonly observations: readonly FaultInjectionObservation[];
}): FaultInjectionReportSummary | undefined {
  if (input.planned.length === 0 && input.observations.length === 0) {
    return undefined;
  }

  const containedCaseCount = input.observations.filter(
    (observation) => observation.contained,
  ).length;
  const recoveredCaseCount = input.observations.filter(
    (observation) => observation.recovered,
  ).length;
  const overclaimPreventedCount = input.observations.filter(
    (observation) => observation.overclaimPrevented,
  ).length;
  const firstViolatedContracts = input.observations
    .map((observation) => observation.firstViolatedContract)
    .filter((contract): contract is string => contract !== undefined);

  return Object.freeze({
    plannedCaseCount: input.planned.length,
    observedCaseCount: input.observations.length,
    containedCaseCount,
    recoveredCaseCount,
    overclaimPreventedCount,
    containmentRate: rate(containedCaseCount, input.observations.length),
    recoveryRate: rate(recoveredCaseCount, input.observations.length),
    overclaimPreventionRate: rate(overclaimPreventedCount, input.observations.length),
    firstViolatedContracts: Object.freeze([...new Set(firstViolatedContracts)]),
  });
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

function hasSufficientRecommendationEvidence(input: {
  readonly benchmark: BenchmarkSpec;
  readonly trialCount: number;
  readonly primaryMetricSampleCount?: number;
  readonly traceCompleteness: number;
}): boolean {
  const minimumTrials = input.benchmark.validity?.minimumTrialsForRecommendation ?? 3;
  const singleRunOverride =
    input.benchmark.validity?.allowSingleRunRecommendation === true &&
    input.benchmark.trials.count === 1 &&
    input.trialCount === 1;

  if (input.trialCount === 0 || (input.trialCount < minimumTrials && !singleRunOverride)) {
    return false;
  }

  if (input.primaryMetricSampleCount !== undefined) {
    const hasSufficientSamples =
      input.primaryMetricSampleCount >= minimumTrials ||
      (singleRunOverride && input.primaryMetricSampleCount === 1);
    if (input.primaryMetricSampleCount === 0 || !hasSufficientSamples) {
      return false;
    }
  }

  if (input.benchmark.validity?.requireTraceCompleteness === true && input.traceCompleteness < 1) {
    return false;
  }

  return true;
}

function recommendationFor(input: {
  readonly benchmark: BenchmarkSpec;
  readonly trialCount: number;
  readonly primaryMetricSampleCount: number;
  readonly traceCompleteness: number;
  readonly primaryMetric: MetricValue | undefined;
  readonly primaryMetricDirection: MetricDefinition["direction"];
  readonly bestPrimaryMetricValue: number | undefined;
}): RecommendationBoundary {
  if (
    !hasSufficientRecommendationEvidence({
      benchmark: input.benchmark,
      trialCount: input.trialCount,
      primaryMetricSampleCount: input.primaryMetricSampleCount,
      traceCompleteness: input.traceCompleteness,
    })
  ) {
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

function inferredOutcomeStatus(input: {
  readonly benchmark: BenchmarkSpec;
  readonly result: BenchmarkTrialResult;
}): BenchmarkTrialOutcomeStatus {
  if (input.result.outcome !== undefined) {
    return input.result.outcome.status;
  }

  const reliability = input.benchmark.reliability;
  const successMetric = reliability?.successMetric ?? input.benchmark.primaryMetric;
  const value = metricValue(input.result, successMetric);
  if (value === undefined) {
    return "failed";
  }

  const direction = metricDirection(input.benchmark, successMetric);
  const threshold =
    reliability?.successThreshold ?? (direction === "lower_is_better" ? 0 : 1);

  if (direction === "lower_is_better") {
    return value <= threshold ? "passed" : "failed";
  }

  return value >= threshold ? "passed" : "failed";
}

function failureSeverity(input: {
  readonly profile: BenchmarkReliabilityProfile;
  readonly result: BenchmarkTrialResult;
  readonly status: BenchmarkTrialOutcomeStatus;
}): BenchmarkFailureSeverity {
  if (input.result.outcome?.failureSeverity !== undefined) {
    return input.result.outcome.failureSeverity;
  }

  if (input.profile.failureSeverityMetric !== undefined) {
    const value = metricValue(input.result, input.profile.failureSeverityMetric);
    if (value !== undefined) {
      const bounded = Math.max(0, Math.min(4, Math.round(value)));
      return FAILURE_SEVERITY_BY_SCORE.find(([score]) => score === bounded)?.[1] ?? "none";
    }
  }

  return input.status === "failed" ? "medium" : "none";
}

function passAtMetric(input: {
  readonly candidateId: string;
  readonly scoredStatuses: readonly BenchmarkTrialOutcomeStatus[];
  readonly k: number;
}): MetricValue {
  const observedStatuses = input.scoredStatuses.slice(0, input.k);
  const value = observedStatuses.some((status) => status === "passed") ? 1 : 0;

  return Object.freeze({
    metricId: `pass_at_${input.k}`,
    value,
    evidenceRefs: Object.freeze([`${input.candidateId}:pass@${input.k}`]),
  });
}

function reliabilitySummary(input: {
  readonly benchmark: BenchmarkSpec;
  readonly candidateId: string;
  readonly results: readonly BenchmarkTrialResult[];
}): BenchmarkReliabilitySummary | undefined {
  const profile = input.benchmark.reliability;
  if (profile === undefined) {
    return undefined;
  }

  const statuses = input.results.map((result) =>
    inferredOutcomeStatus({ benchmark: input.benchmark, result }),
  );
  const scoredStatuses = statuses.filter((status) => status === "passed" || status === "failed");
  const passedTrials = scoredStatuses.filter((status) => status === "passed").length;
  const failedTrials = scoredStatuses.length - passedTrials;
  const skippedTrials = statuses.filter((status) => status === "skipped").length;
  const excludedTrials = statuses.filter((status) => status === "excluded").length;
  const retriedTrials = input.results.filter(
    (result) =>
      (result.outcome?.attempt !== undefined && result.outcome.attempt > 1) ||
      result.outcome?.retryOfTrialId !== undefined,
  ).length;
  const passRate = scoredStatuses.length === 0 ? null : passedTrials / scoredStatuses.length;
  const variance = passRate === null ? null : passRate * (1 - passRate);
  const consistency = passRate === null ? null : Math.max(passRate, 1 - passRate);
  const passAt = (profile.passAt ?? DEFAULT_PASS_AT).map((k) =>
    passAtMetric({ candidateId: input.candidateId, scoredStatuses, k }),
  );
  const severityScores = input.results.map((result, index) =>
    FAILURE_SEVERITY_SCORE[
      failureSeverity({ profile, result, status: statuses[index] ?? "failed" })
    ],
  );
  const maxSeverityScore = severityScores.length === 0 ? 0 : Math.max(...severityScores);
  const maxFailureSeverity =
    FAILURE_SEVERITY_BY_SCORE.find(([score]) => score === maxSeverityScore)?.[1] ?? "none";
  const averageFailureSeverity = average(severityScores) ?? 0;
  const perturbationLabels = [
    ...new Set([
      ...(profile.perturbationLabels ?? []),
      ...input.results
        .map((result) => result.outcome?.perturbationLabel)
        .filter((label): label is string => label !== undefined),
    ]),
  ];
  const perturbations = perturbationLabels.map((label) => {
    const indexes = input.results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.outcome?.perturbationLabel === label)
      .map(({ index }) => index);
    const labelStatuses = indexes
      .map((index) => statuses[index])
      .filter((status): status is BenchmarkTrialOutcomeStatus => status !== undefined)
      .filter((status) => status === "passed" || status === "failed");
    const labelPassed = labelStatuses.filter((status) => status === "passed").length;

    return Object.freeze({
      label,
      trialCount: indexes.length,
      passRate: labelStatuses.length === 0 ? null : labelPassed / labelStatuses.length,
    });
  });
  const minimumScoredTrials =
    profile.minimumScoredTrials ??
    input.benchmark.validity?.minimumTrialsForRecommendation ??
    input.benchmark.trials.count;
  const warnings = [
    ...(scoredStatuses.length < minimumScoredTrials
      ? [
          `Only ${scoredStatuses.length}/${minimumScoredTrials} scored trials; reliability recommendation remains underpowered.`,
        ]
      : []),
    ...(skippedTrials > 0 ? [`${skippedTrials} skipped trial(s) remain visible.`] : []),
    ...(excludedTrials > 0 ? [`${excludedTrials} excluded trial(s) remain visible.`] : []),
    ...(retriedTrials > 0 ? [`${retriedTrials} retried attempt(s) remain visible.`] : []),
  ];

  return Object.freeze({
    ...(profile.id === undefined ? {} : { profileId: profile.id }),
    totalTrials: input.results.length,
    scoredTrials: scoredStatuses.length,
    passedTrials,
    failedTrials,
    skippedTrials,
    excludedTrials,
    retriedTrials,
    passRate,
    consistency,
    variance,
    passAt: Object.freeze(passAt),
    maxFailureSeverity,
    averageFailureSeverity,
    perturbations: Object.freeze(perturbations),
    warnings: Object.freeze(warnings),
  });
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
  const primaryMetricSampleCount = metricSampleCount(input.benchmark.primaryMetric, input.results);
  const guardrails = (input.benchmark.guardrailMetrics ?? [])
    .map((metricId) => aggregateMetric(metricId, input.results))
    .filter((metric): metric is MetricValue => metric !== undefined);
  const traceCompleteness =
    average(input.results.map((result) => result.diagnostics.completeness)) ?? 0;
  const reliability = reliabilitySummary({
    benchmark: input.benchmark,
    candidateId: input.candidateId,
    results: input.results,
  });
  const recommendation = recommendationFor({
    benchmark: input.benchmark,
    trialCount: input.results.length,
    primaryMetricSampleCount,
    traceCompleteness,
    primaryMetric,
    primaryMetricDirection: input.primaryMetricDirection,
    bestPrimaryMetricValue: input.bestPrimaryMetricValue,
  });
  const faultInjection = faultInjectionSummary({
    planned: input.benchmark.faultInjections ?? [],
    observations: faultInjectionObservations(input.results),
  });
  const rationale = [
    primaryMetric === undefined
      ? `${input.benchmark.primaryMetric} average: missing`
      : `${input.benchmark.primaryMetric} average: ${primaryMetric.value}`,
    `${input.benchmark.primaryMetric} samples: ${primaryMetricSampleCount}/${input.results.length}`,
    `trace completeness: ${traceCompleteness}`,
    `trials: ${input.results.length}`,
    ...(reliability === undefined
      ? []
      : [
          `reliability pass rate: ${
            reliability.passRate === null ? "missing" : reliability.passRate
          }`,
          `reliability consistency: ${
            reliability.consistency === null ? "missing" : reliability.consistency
          }`,
          `max failure severity: ${reliability.maxFailureSeverity}`,
        ]),
    ...(faultInjection === undefined
      ? []
      : [
          `fault injections observed: ${faultInjection.observedCaseCount}/${faultInjection.plannedCaseCount}`,
          `fault containment rate: ${faultInjection.containmentRate}`,
        ]),
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
    ...(reliability === undefined ? {} : { reliability }),
    rationale: Object.freeze(rationale),
    ...(faultInjection === undefined ? {} : { faultInjection }),
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
    .filter((results) => {
      return hasSufficientRecommendationEvidence({
        benchmark: input.benchmark,
        trialCount: results.length,
        primaryMetricSampleCount: metricSampleCount(input.benchmark.primaryMetric, results),
        traceCompleteness: average(results.map((result) => result.diagnostics.completeness)) ?? 0,
      });
    })
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
  const faultInjection = faultInjectionSummary({
    planned: input.benchmark.faultInjections ?? [],
    observations: faultInjectionObservations(input.results),
  });
  const faultInjectionEvidenceGap =
    (input.benchmark.faultInjections ?? []).length > 0 &&
    (faultInjection?.observedCaseCount ?? 0) === 0
      ? ["Fault injections were configured but no trial observations recorded their outcomes."]
      : [];
  const traceEventCount = input.results.reduce(
    (total, result) => total + result.traceEvents.length,
    0,
  );
  const artifactCount = input.results.reduce((total, result) => total + result.artifacts.length, 0);
  const metricCount = input.results.reduce((total, result) => total + result.metrics.length, 0);
  const reliabilityCandidates = candidates.filter(
    (candidate): candidate is BenchmarkReportCandidate & { reliability: BenchmarkReliabilitySummary } =>
      candidate.reliability !== undefined,
  );

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
      ...(reliabilityCandidates.length === 0
        ? []
        : [
            `Reliability profile summarized ${reliabilityCandidates.reduce(
              (total, candidate) => total + candidate.reliability.scoredTrials,
              0,
            )} scored trial outcomes without hiding skips, exclusions, or retries.`,
          ]),
      ...(faultInjection === undefined
        ? []
        : [
            `Observed ${faultInjection.observedCaseCount}/${faultInjection.plannedCaseCount} planned fault-injection cases.`,
          ]),
    ]),
    inferences: Object.freeze(
      [
        ...(insufficientEvidence.length > 0 || faultInjectionEvidenceGap.length > 0
          ? ["At least one candidate lacks enough evidence for a confident recommendation."]
          : [
              "Trial evidence is sufficient for the configured recommendation threshold.",
              ...(faultInjection === undefined
                ? []
                : ["Fault-injection observations are included in the evidence boundary."]),
            ]),
        ...reliabilityCandidates.flatMap((candidate) =>
          candidate.reliability.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
        ),
      ],
    ),
    recommendations: Object.freeze(
      candidates.map((candidate) => {
        if (candidate.reliability === undefined) {
          return `${candidate.candidateId}: ${candidate.recommendation}`;
        }

        const passRate =
          candidate.reliability.passRate === null ? "missing" : candidate.reliability.passRate;
        const consistency =
          candidate.reliability.consistency === null
            ? "missing"
            : candidate.reliability.consistency;
        return `${candidate.candidateId}: ${candidate.recommendation}; reliability pass_rate=${passRate}, consistency=${consistency}, max_failure_severity=${candidate.reliability.maxFailureSeverity}`;
      }),
    ),
    candidates: Object.freeze(candidates),
    evidence: Object.freeze({
      traceEventCount,
      artifactCount,
      metricCount,
    }),
    insufficientEvidence: Object.freeze([...insufficientEvidence, ...faultInjectionEvidenceGap]),
    ...(faultInjection === undefined ? {} : { faultInjection }),
  });
}

export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
  const reliabilityCandidates = report.candidates.filter(
    (candidate): candidate is BenchmarkReportCandidate & { reliability: BenchmarkReliabilitySummary } =>
      candidate.reliability !== undefined,
  );
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

  if (reliabilityCandidates.length > 0) {
    lines.push(
      "## Reliability",
      "",
      "| Candidate | Passed / Scored | Pass rate | Consistency | Variance | Max failure severity | Retries | Skipped | Excluded |",
      "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
      ...reliabilityCandidates.map((candidate) => {
        const reliability = candidate.reliability;
        return `| ${candidate.candidateId} | ${reliability.passedTrials}/${reliability.scoredTrials} | ${reliability.passRate ?? "n/a"} | ${reliability.consistency ?? "n/a"} | ${reliability.variance ?? "n/a"} | ${reliability.maxFailureSeverity} | ${reliability.retriedTrials} | ${reliability.skippedTrials} | ${reliability.excludedTrials} |`;
      }),
      "",
    );

    const reliabilityWarnings = reliabilityCandidates.flatMap((candidate) =>
      candidate.reliability.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
    );
    if (reliabilityWarnings.length > 0) {
      lines.push(
        "### Reliability Warnings",
        "",
        ...reliabilityWarnings.map((warning) => `- ${warning}`),
        "",
      );
    }
  }

  if (report.insufficientEvidence.length > 0) {
    lines.push(
      "## Insufficient Evidence",
      "",
      ...report.insufficientEvidence.map((item) => `- ${item}`),
      "",
    );
  }

  if (report.faultInjection !== undefined) {
    lines.push(
      "## Fault Injection",
      "",
      `- Planned cases: ${report.faultInjection.plannedCaseCount}`,
      `- Observed cases: ${report.faultInjection.observedCaseCount}`,
      `- Containment rate: ${report.faultInjection.containmentRate}`,
      `- Recovery rate: ${report.faultInjection.recoveryRate}`,
      `- Overclaim prevention rate: ${report.faultInjection.overclaimPreventionRate}`,
      `- First violated contracts: ${
        report.faultInjection.firstViolatedContracts.length === 0
          ? "none recorded"
          : report.faultInjection.firstViolatedContracts.join(", ")
      }`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}
