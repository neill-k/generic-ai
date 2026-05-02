import type {
  BenchmarkFailureSeverity,
  BenchmarkReliabilityProfile,
  BenchmarkReliabilitySummary,
  BenchmarkReport,
  BenchmarkReportCandidate,
  BenchmarkReportConfidence,
  BenchmarkReversibilitySummary,
  BenchmarkPassKSummary,
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
  BenchmarkToolUseExpectation,
  BenchmarkToolUseProfile,
  BenchmarkToolUseCaseSpec,
  ContextualIntegrityCaseSpec,
  ContextualIntegrityObservation,
  ContextualIntegrityProfile,
  ContextualIntegrityReportSummary,
  ContextualIntegrityTransmissionExpectation,
  ToolUseObservation,
  ToolUseReportSummary,
  WebResearchCaseSpec,
  WebResearchObservation,
  WebResearchProfile,
  WebResearchReportSummary,
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

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function configuredTrialCount(benchmark: BenchmarkSpec): number {
  return positiveIntegerOrDefault(benchmark.trials?.count, 1);
}

function isSmokeBenchmark(benchmark: BenchmarkSpec): boolean {
  return benchmark.smoke === true || benchmark.trials?.smoke === true;
}

function explicitMinTrials(benchmark: BenchmarkSpec): number | undefined {
  return benchmark.minTrials ?? benchmark.trials?.minTrials;
}

function minTrialsForRecommendation(benchmark: BenchmarkSpec): number {
  return positiveIntegerOrDefault(
    explicitMinTrials(benchmark) ?? benchmark.validity?.minimumTrialsForRecommendation,
    3,
  );
}

function passKHorizon(benchmark: BenchmarkSpec): number {
  return positiveIntegerOrDefault(benchmark.trials?.passK, configuredTrialCount(benchmark));
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

function metricValues(
  metricId: string,
  results: readonly BenchmarkTrialResult[],
): readonly MetricValue[] {
  return Object.freeze(
    results.flatMap((result) => result.metrics.filter((metric) => metric.metricId === metricId)),
  );
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

function toolUseObservations(
  results: readonly BenchmarkTrialResult[],
): readonly ToolUseObservation[] {
  return Object.freeze(results.flatMap((result) => result.toolUse ?? []));
}

function contextualIntegrityObservations(
  results: readonly BenchmarkTrialResult[],
): readonly ContextualIntegrityObservation[] {
  return Object.freeze(results.flatMap((result) => result.contextualIntegrity ?? []));
}

function webResearchObservations(
  results: readonly BenchmarkTrialResult[],
): readonly WebResearchObservation[] {
  return Object.freeze(results.flatMap((result) => result.webResearch ?? []));
}

function plannedToolUseCase(
  profile: BenchmarkToolUseProfile | undefined,
  caseRef: string,
): BenchmarkToolUseCaseSpec | undefined {
  return profile?.cases.find((entry) => entry.id === caseRef);
}

function observationExpectation(input: {
  readonly profile: BenchmarkToolUseProfile | undefined;
  readonly observation: ToolUseObservation;
}): BenchmarkToolUseExpectation {
  return (
    input.observation.expectation ??
    plannedToolUseCase(input.profile, input.observation.caseRef)?.expectation ??
    "optional"
  );
}

function directAnswerEligible(input: {
  readonly profile: BenchmarkToolUseProfile | undefined;
  readonly observation: ToolUseObservation;
}): boolean {
  const planned = plannedToolUseCase(input.profile, input.observation.caseRef);
  return (
    input.observation.directAnswerEligible ??
    planned?.directAnswerEligible ??
    planned?.expectation === "wasteful"
  );
}

function toolUseBudgetLimit(input: {
  readonly profile: BenchmarkToolUseProfile | undefined;
  readonly observation: ToolUseObservation;
}): number | undefined {
  return (
    input.observation.budgetLimit ??
    plannedToolUseCase(input.profile, input.observation.caseRef)?.maxToolCalls ??
    input.profile?.maxToolCalls
  );
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizedToolUseObservation(input: {
  readonly profile: BenchmarkToolUseProfile | undefined;
  readonly observation: ToolUseObservation;
}): {
  readonly caseRef: string;
  readonly expectation: BenchmarkToolUseExpectation;
  readonly toolCalls: number;
  readonly necessaryToolCalls: number;
  readonly unnecessaryToolCalls: number;
  readonly avoidedToolCalls: number;
  readonly budgetViolated: boolean;
  readonly directAnswerEligible: boolean;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly evidenceRefs: readonly string[];
} {
  const expectation = observationExpectation(input);
  const planned = plannedToolUseCase(input.profile, input.observation.caseRef);
  const toolCalls = nonNegativeInteger(input.observation.toolCalls);
  const necessaryFallback =
    expectation === "wasteful" ? 0 : Math.min(toolCalls, planned?.expectedToolCalls ?? toolCalls);
  const necessaryToolCalls = Math.min(
    toolCalls,
    nonNegativeInteger(input.observation.necessaryToolCalls ?? necessaryFallback),
  );
  const unnecessaryToolCalls = Math.min(
    toolCalls - necessaryToolCalls,
    nonNegativeInteger(input.observation.unnecessaryToolCalls ?? toolCalls - necessaryToolCalls),
  );
  const isDirectAnswerEligible = directAnswerEligible(input);
  const avoidedToolCalls = nonNegativeInteger(
    input.observation.avoidedToolCalls ?? (isDirectAnswerEligible && toolCalls === 0 ? 1 : 0),
  );
  const budgetLimit = toolUseBudgetLimit(input);
  const budgetViolated =
    input.observation.budgetViolated ?? (budgetLimit !== undefined && toolCalls > budgetLimit);

  return Object.freeze({
    caseRef: input.observation.caseRef,
    expectation,
    toolCalls,
    necessaryToolCalls,
    unnecessaryToolCalls,
    avoidedToolCalls,
    budgetViolated,
    directAnswerEligible: isDirectAnswerEligible,
    ...(input.observation.costUsd === undefined ? {} : { costUsd: input.observation.costUsd }),
    ...(input.observation.latencyMs === undefined
      ? {}
      : { latencyMs: input.observation.latencyMs }),
    evidenceRefs: input.observation.evidenceRefs,
  });
}

function toolUseSummary(input: {
  readonly profile: BenchmarkToolUseProfile | undefined;
  readonly observations: readonly ToolUseObservation[];
}): ToolUseReportSummary | undefined {
  if (input.profile === undefined && input.observations.length === 0) {
    return undefined;
  }

  const normalized = input.observations.map((observation) =>
    normalizedToolUseObservation({ profile: input.profile, observation }),
  );
  const plannedCaseCount = input.profile?.cases.length ?? 0;
  const observedCaseRefs = new Set(input.observations.map((observation) => observation.caseRef));
  const missingPlannedCases =
    input.profile?.cases.filter((entry) => !observedCaseRefs.has(entry.id)) ?? [];
  const necessaryToolCalls = normalized.reduce(
    (total, observation) => total + observation.necessaryToolCalls,
    0,
  );
  const unnecessaryToolCalls = normalized.reduce(
    (total, observation) => total + observation.unnecessaryToolCalls,
    0,
  );
  const avoidedToolCalls = normalized.reduce(
    (total, observation) => total + observation.avoidedToolCalls,
    0,
  );
  const disciplineDenominator = necessaryToolCalls + unnecessaryToolCalls + avoidedToolCalls;
  const totalCostValues = normalized
    .map((observation) => observation.costUsd)
    .filter((value): value is number => value !== undefined);
  const totalLatencyValues = normalized
    .map((observation) => observation.latencyMs)
    .filter((value): value is number => value !== undefined);
  const expectations: readonly BenchmarkToolUseExpectation[] = ["required", "optional", "wasteful"];
  const byExpectation = expectations.map((expectation) => {
    const plannedCaseCountForExpectation =
      input.profile?.cases.filter((entry) => entry.expectation === expectation).length ?? 0;
    const observed = normalized.filter((observation) => observation.expectation === expectation);
    const observedCaseCountForExpectation = new Set(
      observed.map((observation) => observation.caseRef),
    ).size;

    return Object.freeze({
      expectation,
      plannedCaseCount: plannedCaseCountForExpectation,
      observedCaseCount: observedCaseCountForExpectation,
      toolCalls: observed.reduce((total, observation) => total + observation.toolCalls, 0),
      unnecessaryToolCalls: observed.reduce(
        (total, observation) => total + observation.unnecessaryToolCalls,
        0,
      ),
      avoidedToolCalls: observed.reduce(
        (total, observation) => total + observation.avoidedToolCalls,
        0,
      ),
      budgetViolations: observed.filter((observation) => observation.budgetViolated).length,
    });
  });
  const warnings = [
    ...(missingPlannedCases.length > 0
      ? [
          `Missing tool-use observations for ${missingPlannedCases
            .map((entry) => entry.id)
            .join(", ")}.`,
        ]
      : []),
    ...(normalized.some((observation) => observation.budgetViolated)
      ? [
          `${normalized.filter((observation) => observation.budgetViolated).length} tool budget violation(s) recorded.`,
        ]
      : []),
  ];

  return Object.freeze({
    ...(input.profile?.id === undefined ? {} : { profileId: input.profile.id }),
    plannedCaseCount,
    observedCaseCount: observedCaseRefs.size,
    totalToolCalls: normalized.reduce((total, observation) => total + observation.toolCalls, 0),
    necessaryToolCalls,
    unnecessaryToolCalls,
    avoidedToolCalls,
    budgetViolations: normalized.filter((observation) => observation.budgetViolated).length,
    directAnswerOpportunities: normalized.filter((observation) => observation.directAnswerEligible)
      .length,
    efficiencyScore:
      disciplineDenominator === 0
        ? null
        : (necessaryToolCalls + avoidedToolCalls) / disciplineDenominator,
    ...(totalCostValues.length === 0
      ? {}
      : { totalCostUsd: totalCostValues.reduce((total, value) => total + value, 0) }),
    ...(totalLatencyValues.length === 0
      ? {}
      : { totalLatencyMs: totalLatencyValues.reduce((total, value) => total + value, 0) }),
    byExpectation: Object.freeze(byExpectation),
    evidenceRefs: Object.freeze([
      ...new Set(input.observations.flatMap((observation) => observation.evidenceRefs)),
    ]),
    warnings: Object.freeze(warnings),
  });
}

function plannedContextualIntegrityCase(
  profile: ContextualIntegrityProfile | undefined,
  caseRef: string,
): ContextualIntegrityCaseSpec | undefined {
  return profile?.cases.find((entry) => entry.id === caseRef);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function matchingTransmissionPrinciples(input: {
  readonly profile: ContextualIntegrityProfile | undefined;
  readonly planned: ContextualIntegrityCaseSpec | undefined;
  readonly observation: ContextualIntegrityObservation;
}) {
  if (input.profile === undefined) {
    return [];
  }

  const senderRef = input.observation.senderRef ?? input.planned?.senderRef;
  const recipientRef = input.observation.recipientRef ?? input.planned?.recipientRef;
  const purpose = input.observation.purpose ?? input.planned?.purpose;

  return input.profile.transmissionPrinciples.filter(
    (principle) =>
      principle.senderRef === senderRef &&
      principle.recipientRef === recipientRef &&
      principle.purpose === purpose,
  );
}

function plannedContextualIntegrityRefs(input: {
  readonly profile: ContextualIntegrityProfile | undefined;
  readonly planned: ContextualIntegrityCaseSpec | undefined;
  readonly observation: ContextualIntegrityObservation;
  readonly expectation: ContextualIntegrityTransmissionExpectation;
}): readonly string[] {
  const fromPrinciples = matchingTransmissionPrinciples(input)
    .filter((principle) => principle.expectation === input.expectation)
    .flatMap((principle) => principle.dataClassRefs);
  const fromCase =
    input.expectation === "required"
      ? input.planned?.requiredDataClassRefs
      : input.expectation === "permitted"
        ? input.planned?.allowedDataClassRefs
        : input.planned?.forbiddenDataClassRefs;

  return uniqueStrings([...(fromCase ?? []), ...fromPrinciples]);
}

function normalizedContextualIntegrityObservation(input: {
  readonly profile: ContextualIntegrityProfile | undefined;
  readonly observation: ContextualIntegrityObservation;
}): {
  readonly caseRef: string;
  readonly disclosedDataClassCount: number;
  readonly allowedDisclosureCount: number;
  readonly requiredDisclosureCount: number;
  readonly requiredDisclosureMisses: number;
  readonly prohibitedDisclosureCount: number;
  readonly prohibitedDisclosureViolations: number;
  readonly utilitySatisfied: boolean;
  readonly evidenceRefs: readonly string[];
} {
  const planned = plannedContextualIntegrityCase(input.profile, input.observation.caseRef);
  const disclosedRefs = new Set(input.observation.disclosedDataClassRefs);
  const explicitRequiredRefs = input.observation.requiredDisclosureRefs ?? [];
  const explicitProhibitedRefs = input.observation.prohibitedDisclosureRefs ?? [];
  const requiredRefs = uniqueStrings([
    ...plannedContextualIntegrityRefs({
      profile: input.profile,
      planned,
      observation: input.observation,
      expectation: "required",
    }),
    ...explicitRequiredRefs,
  ]);
  const permittedRefs = uniqueStrings([
    ...plannedContextualIntegrityRefs({
      profile: input.profile,
      planned,
      observation: input.observation,
      expectation: "permitted",
    }),
    ...requiredRefs,
  ]);
  const prohibitedRefs = uniqueStrings([
    ...plannedContextualIntegrityRefs({
      profile: input.profile,
      planned,
      observation: input.observation,
      expectation: "prohibited",
    }),
    ...explicitProhibitedRefs,
  ]);

  return Object.freeze({
    caseRef: input.observation.caseRef,
    disclosedDataClassCount: disclosedRefs.size,
    allowedDisclosureCount: permittedRefs.filter((ref) => disclosedRefs.has(ref)).length,
    requiredDisclosureCount: requiredRefs.length,
    requiredDisclosureMisses: requiredRefs.filter((ref) => !disclosedRefs.has(ref)).length,
    prohibitedDisclosureCount: prohibitedRefs.length,
    prohibitedDisclosureViolations: prohibitedRefs.filter((ref) => disclosedRefs.has(ref)).length,
    utilitySatisfied: input.observation.utilitySatisfied,
    evidenceRefs: input.observation.evidenceRefs,
  });
}

function contextualIntegritySummary(input: {
  readonly profile: ContextualIntegrityProfile | undefined;
  readonly observations: readonly ContextualIntegrityObservation[];
}): ContextualIntegrityReportSummary | undefined {
  if (input.profile === undefined && input.observations.length === 0) {
    return undefined;
  }

  const normalized = input.observations.map((observation) =>
    normalizedContextualIntegrityObservation({ profile: input.profile, observation }),
  );
  const plannedCaseCount = input.profile?.cases.length ?? 0;
  const observedCaseRefs = new Set(input.observations.map((observation) => observation.caseRef));
  const missingPlannedCases =
    input.profile?.cases.filter((entry) => !observedCaseRefs.has(entry.id)) ?? [];
  const utilitySatisfiedCount = normalized.filter(
    (observation) => observation.utilitySatisfied,
  ).length;
  const requiredDisclosureCount = normalized.reduce(
    (total, observation) => total + observation.requiredDisclosureCount,
    0,
  );
  const requiredDisclosureMissCount = normalized.reduce(
    (total, observation) => total + observation.requiredDisclosureMisses,
    0,
  );
  const prohibitedDisclosureCount = normalized.reduce(
    (total, observation) => total + observation.prohibitedDisclosureCount,
    0,
  );
  const prohibitedDisclosureViolationCount = normalized.reduce(
    (total, observation) => total + observation.prohibitedDisclosureViolations,
    0,
  );
  const allowedDisclosureCount = normalized.reduce(
    (total, observation) => total + observation.allowedDisclosureCount,
    0,
  );
  const compliantCaseCount = normalized.filter(
    (observation) =>
      observation.requiredDisclosureMisses === 0 &&
      observation.prohibitedDisclosureViolations === 0,
  ).length;
  const utilityRate = rate(utilitySatisfiedCount, normalized.length);
  const disclosureComplianceRate = rate(compliantCaseCount, normalized.length);
  const leakageRate = rate(
    normalized.filter((observation) => observation.prohibitedDisclosureViolations > 0).length,
    normalized.length,
  );
  const warnings = [
    ...(missingPlannedCases.length > 0
      ? [
          `Missing contextual-integrity observations for ${missingPlannedCases
            .map((entry) => entry.id)
            .join(", ")}.`,
        ]
      : []),
    ...(prohibitedDisclosureViolationCount > 0
      ? [`${prohibitedDisclosureViolationCount} prohibited disclosure violation(s) recorded.`]
      : []),
    ...(requiredDisclosureMissCount > 0
      ? [`${requiredDisclosureMissCount} required disclosure miss(es) recorded.`]
      : []),
  ];

  return Object.freeze({
    ...(input.profile?.id === undefined ? {} : { profileId: input.profile.id }),
    plannedCaseCount,
    observedCaseCount: observedCaseRefs.size,
    utilitySatisfiedCount,
    utilityRate,
    requiredDisclosureCount,
    requiredDisclosureMissCount,
    prohibitedDisclosureCount,
    prohibitedDisclosureViolationCount,
    allowedDisclosureCount,
    leakageRate,
    contextualIntegrityScore:
      normalized.length === 0 ? null : (utilityRate + disclosureComplianceRate) / 2,
    byCase: Object.freeze(
      normalized.map((observation) =>
        Object.freeze({
          caseRef: observation.caseRef,
          disclosedDataClassCount: observation.disclosedDataClassCount,
          requiredDisclosureMisses: observation.requiredDisclosureMisses,
          prohibitedDisclosureViolations: observation.prohibitedDisclosureViolations,
          utilitySatisfied: observation.utilitySatisfied,
        }),
      ),
    ),
    evidenceRefs: Object.freeze([
      ...new Set(input.observations.flatMap((observation) => observation.evidenceRefs)),
    ]),
    warnings: Object.freeze(warnings),
  });
}

function plannedWebResearchCase(
  profile: WebResearchProfile | undefined,
  caseRef: string,
): WebResearchCaseSpec | undefined {
  return profile?.cases.find((entry) => entry.id === caseRef);
}

function normalizedWebResearchObservation(input: {
  readonly profile: WebResearchProfile | undefined;
  readonly observation: WebResearchObservation;
}): {
  readonly caseRef: string;
  readonly answerCorrect: boolean;
  readonly citationRequired: boolean;
  readonly citationRequirementMet: boolean;
  readonly requiredSourceCoverage: number;
  readonly reconciliationRequired: boolean;
  readonly reconciliationSatisfied: boolean;
  readonly staleSourceUseCount: number;
  readonly chineseTextPreserved: boolean;
  readonly evidenceRefs: readonly string[];
} {
  const planned = plannedWebResearchCase(input.profile, input.observation.caseRef);
  const citedRefs = new Set(input.observation.citedSourceRefs);
  const requiredSourceRefs = planned?.requiredSourceRefs ?? [];
  const citedRequiredCount = requiredSourceRefs.filter((ref) => citedRefs.has(ref)).length;
  const citationRequirementMet =
    planned?.citationRequired !== true ||
    (citedRefs.size > 0 &&
      (requiredSourceRefs.length === 0 || citedRequiredCount === requiredSourceRefs.length));
  const reconciledRefs = new Set(input.observation.reconciledSourceRefs ?? []);
  const reconciliationRefs = new Set([...reconciledRefs, ...citedRefs]);
  const requiredReconciledCount = requiredSourceRefs.filter((ref) =>
    reconciliationRefs.has(ref),
  ).length;
  const requiredSourcesSatisfiedForReconciliation =
    requiredSourceRefs.length === 0 ||
    requiredReconciledCount >= Math.min(2, requiredSourceRefs.length);
  const reconciliationSatisfied =
    planned?.requiresCrossSourceReconciliation !== true ||
    (requiredSourcesSatisfiedForReconciliation && reconciliationRefs.size >= 2);
  const plannedStaleRefs = new Set(planned?.staleSourceRefs ?? []);
  const observedStaleRefs = new Set([
    ...(input.observation.staleSourceRefs ?? []),
    ...(input.observation.staleSourceUsedRefs ?? []),
  ]);
  const staleSourceUseCount = [...new Set([...plannedStaleRefs, ...observedStaleRefs])].filter(
    (ref) => input.observation.staleSourceUsedRefs?.includes(ref) ?? false,
  ).length;

  return Object.freeze({
    caseRef: input.observation.caseRef,
    answerCorrect: input.observation.answerCorrect,
    citationRequired: planned?.citationRequired === true,
    citationRequirementMet,
    requiredSourceCoverage:
      requiredSourceRefs.length === 0 ? 1 : rate(citedRequiredCount, requiredSourceRefs.length),
    reconciliationRequired: planned?.requiresCrossSourceReconciliation === true,
    reconciliationSatisfied,
    staleSourceUseCount,
    chineseTextPreserved: input.observation.chineseTextPreserved ?? true,
    evidenceRefs: input.observation.evidenceRefs,
  });
}

function webResearchSummary(input: {
  readonly profile: WebResearchProfile | undefined;
  readonly observations: readonly WebResearchObservation[];
}): WebResearchReportSummary | undefined {
  if (input.profile === undefined && input.observations.length === 0) {
    return undefined;
  }

  const normalized = input.observations.map((observation) =>
    normalizedWebResearchObservation({ profile: input.profile, observation }),
  );
  const plannedCaseCount = input.profile?.cases.length ?? 0;
  const observedCaseRefs = new Set(input.observations.map((observation) => observation.caseRef));
  const missingPlannedCases =
    input.profile?.cases.filter((entry) => !observedCaseRefs.has(entry.id)) ?? [];
  const citationRequiredCases =
    input.profile?.cases.filter((entry) => entry.citationRequired === true) ?? [];
  const reconciliationRequiredCases =
    input.profile?.cases.filter((entry) => entry.requiresCrossSourceReconciliation === true) ?? [];
  const underspecifiedReconciliationCases = reconciliationRequiredCases.filter(
    (entry) => (entry.requiredSourceRefs?.length ?? 0) < 2,
  );
  const answerCorrectCount = normalized.filter((observation) => observation.answerCorrect).length;
  const citationCoverageCount = normalized.filter(
    (observation) => observation.citationRequired && observation.citationRequirementMet,
  ).length;
  const reconciliationSatisfiedCount = normalized.filter(
    (observation) => observation.reconciliationRequired && observation.reconciliationSatisfied,
  ).length;
  const staleSourceUseCount = normalized.reduce(
    (total, observation) => total + observation.staleSourceUseCount,
    0,
  );
  const chineseTextPreservedCount = normalized.filter(
    (observation) => observation.chineseTextPreserved,
  ).length;
  const warnings = [
    ...(missingPlannedCases.length > 0
      ? [
          `Missing web-research observations for ${missingPlannedCases
            .map((entry) => entry.id)
            .join(", ")}.`,
        ]
      : []),
    ...(underspecifiedReconciliationCases.length > 0
      ? [
          `Cross-source reconciliation is required with fewer than two required sources for ${underspecifiedReconciliationCases
            .map((entry) => entry.id)
            .join(", ")}.`,
        ]
      : []),
    ...(staleSourceUseCount > 0 ? [`${staleSourceUseCount} stale-source use(s) recorded.`] : []),
    ...(normalized.some((observation) => !observation.chineseTextPreserved)
      ? ["At least one web-research observation reported corrupted Chinese text."]
      : []),
  ];

  return Object.freeze({
    ...(input.profile?.id === undefined ? {} : { profileId: input.profile.id }),
    ...(input.profile?.locale === undefined ? {} : { locale: input.profile.locale }),
    plannedCaseCount,
    observedCaseCount: observedCaseRefs.size,
    answerCorrectCount,
    answerCorrectRate: rate(answerCorrectCount, normalized.length),
    citationRequiredCount: citationRequiredCases.length,
    citationCoverageCount,
    citationCoverageRate: rate(citationCoverageCount, citationRequiredCases.length),
    reconciliationRequiredCount: reconciliationRequiredCases.length,
    reconciliationSatisfiedCount,
    reconciliationRate: rate(reconciliationSatisfiedCount, reconciliationRequiredCases.length),
    staleSourceUseCount,
    chineseTextPreservedCount,
    chineseTextPreservationRate: rate(chineseTextPreservedCount, normalized.length),
    byCase: Object.freeze(
      normalized.map((observation) =>
        Object.freeze({
          caseRef: observation.caseRef,
          answerCorrect: observation.answerCorrect,
          citationRequirementMet: observation.citationRequirementMet,
          requiredSourceCoverage: observation.requiredSourceCoverage,
          reconciliationSatisfied: observation.reconciliationSatisfied,
          staleSourceUseCount: observation.staleSourceUseCount,
          chineseTextPreserved: observation.chineseTextPreserved,
        }),
      ),
    ),
    evidenceRefs: Object.freeze([
      ...new Set(input.observations.flatMap((observation) => observation.evidenceRefs)),
    ]),
    warnings: Object.freeze(warnings),
  });
}

function reversibilitySummary(
  results: readonly BenchmarkTrialResult[],
): BenchmarkReversibilitySummary | undefined {
  const events = results.flatMap((result) =>
    result.traceEvents.filter((event) => event.reversibility !== undefined),
  );
  if (events.length === 0) {
    return undefined;
  }

  const evidenceRefs = events.map((event) => event.id);

  return Object.freeze({
    totalEventCount: events.length,
    irreversibleCount: events.filter((event) => event.reversibility === "irreversible").length,
    reversibleWithCostCount: events.filter(
      (event) => event.reversibility === "reversible-with-cost",
    ).length,
    reversibleCheapCount: events.filter((event) => event.reversibility === "reversible-cheap")
      .length,
    supersededEventCount: events.filter((event) => event.supersedesEventId !== undefined).length,
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
  });
}

function formatReversibility(summary: BenchmarkReversibilitySummary | undefined): string {
  if (summary === undefined) {
    return "not recorded";
  }

  return [
    `irreversible=${summary.irreversibleCount}`,
    `with-cost=${summary.reversibleWithCostCount}`,
    `cheap=${summary.reversibleCheapCount}`,
    `superseded=${summary.supersededEventCount}`,
  ].join(", ");
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

function passKSummary(input: {
  readonly benchmark: BenchmarkSpec;
  readonly results: readonly BenchmarkTrialResult[];
}): BenchmarkPassKSummary | undefined {
  const values = metricValues(input.benchmark.primaryMetric, input.results);
  if (values.length === 0) {
    return undefined;
  }

  const passCount = values.filter((metric) => metric.value >= 1).length;
  const observedPassRate = rate(passCount, values.length);
  const k = passKHorizon(input.benchmark);
  const evidenceRefs = values.flatMap((metric) => metric.evidenceRefs);

  return Object.freeze({
    metricId: input.benchmark.primaryMetric,
    k,
    passCount,
    sampleCount: values.length,
    trialCount: input.results.length,
    observedPassRate,
    value: 1 - (1 - observedPassRate) ** k,
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
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
  const minimumTrials = minTrialsForRecommendation(input.benchmark);
  const hasExplicitMinTrials = explicitMinTrials(input.benchmark) !== undefined;
  const singleRunOverride =
    !hasExplicitMinTrials &&
    input.benchmark.validity?.allowSingleRunRecommendation === true &&
    configuredTrialCount(input.benchmark) === 1 &&
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

function confidenceFor(input: {
  readonly benchmark: BenchmarkSpec;
  readonly trialCount: number;
  readonly primaryMetricSampleCount: number;
  readonly traceCompleteness: number;
  readonly primaryMetric: MetricValue | undefined;
}): BenchmarkReportConfidence {
  const minTrials = minTrialsForRecommendation(input.benchmark);
  const configuredTrials = configuredTrialCount(input.benchmark);
  const smoke = isSmokeBenchmark(input.benchmark);
  const reasons: string[] = [];

  if (input.trialCount < minTrials) {
    reasons.push(`observed trials ${input.trialCount} below minTrials ${minTrials}`);
  }

  if (input.primaryMetric === undefined) {
    reasons.push(`primary metric ${input.benchmark.primaryMetric} missing`);
  } else if (input.primaryMetricSampleCount < minTrials) {
    reasons.push(
      `${input.benchmark.primaryMetric} samples ${input.primaryMetricSampleCount} below minTrials ${minTrials}`,
    );
  }

  if (input.benchmark.validity?.requireTraceCompleteness === true && input.traceCompleteness < 1) {
    reasons.push(`trace completeness ${input.traceCompleteness} below required 1`);
  }

  if (reasons.length > 0) {
    return Object.freeze({
      level: "insufficient_evidence",
      minTrials,
      observedTrials: input.trialCount,
      configuredTrials,
      smoke,
      reasons: Object.freeze(reasons),
    });
  }

  if (smoke) {
    reasons.push("benchmark is marked smoke; recommendations are wiring checks only");
  }

  if (input.trialCount < configuredTrials) {
    reasons.push(`observed trials ${input.trialCount} below configured trials ${configuredTrials}`);
  }

  return Object.freeze({
    level: reasons.length === 0 ? "confident_recommendation" : "bounded_recommendation",
    minTrials,
    observedTrials: input.trialCount,
    configuredTrials,
    smoke,
    reasons: Object.freeze(reasons),
  });
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
  const threshold = reliability?.successThreshold ?? (direction === "lower_is_better" ? 0 : 1);

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
  const severityScores = input.results.map(
    (result, index) =>
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
    configuredTrialCount(input.benchmark);
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
  const traceCompleteness =
    average(input.results.map((result) => result.diagnostics.completeness)) ?? 0;
  const confidence = confidenceFor({
    benchmark: input.benchmark,
    trialCount: input.results.length,
    primaryMetricSampleCount,
    traceCompleteness,
    primaryMetric,
  });
  const guardrails = (input.benchmark.guardrailMetrics ?? [])
    .map((metricId) => aggregateMetric(metricId, input.results))
    .filter((metric): metric is MetricValue => metric !== undefined);
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
  const toolUse = toolUseSummary({
    profile: input.benchmark.toolUse,
    observations: toolUseObservations(input.results),
  });
  const contextualIntegrity = contextualIntegritySummary({
    profile: input.benchmark.contextualIntegrity,
    observations: contextualIntegrityObservations(input.results),
  });
  const webResearch = webResearchSummary({
    profile: input.benchmark.webResearch,
    observations: webResearchObservations(input.results),
  });
  const passK = passKSummary({ benchmark: input.benchmark, results: input.results });
  const reversibility = reversibilitySummary(input.results);
  const rationale = [
    primaryMetric === undefined
      ? `${input.benchmark.primaryMetric} average: missing`
      : `${input.benchmark.primaryMetric} average: ${primaryMetric.value}`,
    `${input.benchmark.primaryMetric} samples: ${primaryMetricSampleCount}/${input.results.length}`,
    `pass^${passKHorizon(input.benchmark)}: ${passK === undefined ? "missing" : passK.value}`,
    `trace completeness: ${traceCompleteness}`,
    `trials: ${input.results.length}/${configuredTrialCount(input.benchmark)}`,
    `minTrials: ${minTrialsForRecommendation(input.benchmark)}`,
    `confidence: ${confidence.level}`,
    `reversibility: ${formatReversibility(reversibility)}`,
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
    ...(toolUse === undefined
      ? []
      : [
          `tool-use cases observed: ${toolUse.observedCaseCount}/${toolUse.plannedCaseCount}`,
          `tool efficiency score: ${toolUse.efficiencyScore ?? "missing"}`,
          `unnecessary tool calls: ${toolUse.unnecessaryToolCalls}`,
          `tool budget violations: ${toolUse.budgetViolations}`,
        ]),
    ...(contextualIntegrity === undefined
      ? []
      : [
          `contextual-integrity cases observed: ${contextualIntegrity.observedCaseCount}/${contextualIntegrity.plannedCaseCount}`,
          `contextual-integrity score: ${contextualIntegrity.contextualIntegrityScore ?? "missing"}`,
          `privacy leakage rate: ${contextualIntegrity.leakageRate}`,
        ]),
    ...(webResearch === undefined
      ? []
      : [
          `web-research cases observed: ${webResearch.observedCaseCount}/${webResearch.plannedCaseCount}`,
          `web-research answer correctness: ${webResearch.answerCorrectRate}`,
          `web-research citation coverage: ${webResearch.citationCoverageRate}`,
          `web-research stale-source uses: ${webResearch.staleSourceUseCount}`,
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
    ...(passK === undefined ? {} : { passK }),
    traceCompleteness,
    recommendation,
    ...(reliability === undefined ? {} : { reliability }),
    confidence,
    ...(reversibility === undefined ? {} : { reversibility }),
    rationale: Object.freeze(rationale),
    ...(faultInjection === undefined ? {} : { faultInjection }),
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(contextualIntegrity === undefined ? {} : { contextualIntegrity }),
    ...(webResearch === undefined ? {} : { webResearch }),
  });
}

function reportConfidence(
  candidates: readonly BenchmarkReportCandidate[],
): BenchmarkReportConfidence {
  if (candidates.length === 0) {
    return Object.freeze({
      level: "insufficient_evidence",
      minTrials: 1,
      observedTrials: 0,
      configuredTrials: 1,
      smoke: false,
      reasons: Object.freeze(["no benchmark candidates were configured"]),
    });
  }

  const reasons = candidates.flatMap((candidate) =>
    candidate.confidence.reasons.map((reason) => `${candidate.candidateId}: ${reason}`),
  );
  const hasInsufficient = candidates.some(
    (candidate) => candidate.confidence.level === "insufficient_evidence",
  );
  const hasBounded = candidates.some(
    (candidate) => candidate.confidence.level === "bounded_recommendation",
  );

  return Object.freeze({
    level: hasInsufficient
      ? "insufficient_evidence"
      : hasBounded
        ? "bounded_recommendation"
        : "confident_recommendation",
    minTrials: Math.max(...candidates.map((candidate) => candidate.confidence.minTrials)),
    observedTrials: Math.min(...candidates.map((candidate) => candidate.confidence.observedTrials)),
    configuredTrials: Math.max(
      ...candidates.map((candidate) => candidate.confidence.configuredTrials),
    ),
    smoke: candidates.some((candidate) => candidate.confidence.smoke),
    reasons: Object.freeze(reasons),
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
  const confidence = reportConfidence(candidates);
  const insufficientEvidence = candidates
    .filter((candidate) => candidate.recommendation === "insufficient_evidence")
    .map((candidate) => `${candidate.candidateId}: ${candidate.rationale.join("; ")}`);
  const faultInjection = faultInjectionSummary({
    planned: input.benchmark.faultInjections ?? [],
    observations: faultInjectionObservations(input.results),
  });
  const toolUse = toolUseSummary({
    profile: input.benchmark.toolUse,
    observations: toolUseObservations(input.results),
  });
  const contextualIntegrity = contextualIntegritySummary({
    profile: input.benchmark.contextualIntegrity,
    observations: contextualIntegrityObservations(input.results),
  });
  const webResearch = webResearchSummary({
    profile: input.benchmark.webResearch,
    observations: webResearchObservations(input.results),
  });
  const reversibility = reversibilitySummary(input.results);
  const faultInjectionEvidenceGap =
    (input.benchmark.faultInjections ?? []).length > 0 &&
    (faultInjection?.observedCaseCount ?? 0) === 0
      ? ["Fault injections were configured but no trial observations recorded their outcomes."]
      : [];
  const toolUseEvidenceGap =
    input.benchmark.toolUse !== undefined &&
    input.benchmark.toolUse.cases.length > 0 &&
    (toolUse?.observedCaseCount ?? 0) === 0
      ? ["Tool-use cases were configured but no trial observations recorded tool discipline."]
      : [];
  const contextualIntegrityEvidenceGap =
    input.benchmark.contextualIntegrity !== undefined &&
    input.benchmark.contextualIntegrity.cases.length > 0 &&
    (contextualIntegrity?.observedCaseCount ?? 0) === 0
      ? [
          "Contextual-integrity cases were configured but no trial observations recorded privacy flow outcomes.",
        ]
      : [];
  const webResearchEvidenceGap =
    input.benchmark.webResearch !== undefined &&
    input.benchmark.webResearch.cases.length > 0 &&
    (webResearch?.observedCaseCount ?? 0) === 0
      ? ["Web-research cases were configured but no trial observations recorded source evidence."]
      : [];
  const traceEventCount = input.results.reduce(
    (total, result) => total + result.traceEvents.length,
    0,
  );
  const artifactCount = input.results.reduce((total, result) => total + result.artifacts.length, 0);
  const metricCount = input.results.reduce((total, result) => total + result.metrics.length, 0);
  const reliabilityCandidates = candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & { reliability: BenchmarkReliabilitySummary } =>
      candidate.reliability !== undefined,
  );
  const toolUseCandidates = candidates.filter(
    (candidate): candidate is BenchmarkReportCandidate & { toolUse: ToolUseReportSummary } =>
      candidate.toolUse !== undefined,
  );
  const contextualIntegrityCandidates = candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & {
      contextualIntegrity: ContextualIntegrityReportSummary;
    } => candidate.contextualIntegrity !== undefined,
  );
  const webResearchCandidates = candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & { webResearch: WebResearchReportSummary } =>
      candidate.webResearch !== undefined,
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
      ...(toolUse === undefined
        ? []
        : [
            `Tool-use profile summarized ${toolUse.observedCaseCount}/${toolUse.plannedCaseCount} planned cases across ${toolUse.totalToolCalls} tool call(s).`,
          ]),
      ...(contextualIntegrity === undefined
        ? []
        : [
            `Contextual-integrity profile summarized ${contextualIntegrity.observedCaseCount}/${contextualIntegrity.plannedCaseCount} planned privacy flow case(s).`,
          ]),
      ...(webResearch === undefined
        ? []
        : [
            `Web-research profile summarized ${webResearch.observedCaseCount}/${webResearch.plannedCaseCount} planned source-reconciliation case(s).`,
          ]),
      ...(reversibility === undefined
        ? []
        : [`Captured reversibility metadata on ${reversibility.totalEventCount} trace events.`]),
    ]),
    inferences: Object.freeze([
      ...(confidence.level === "insufficient_evidence" ||
      insufficientEvidence.length > 0 ||
      faultInjectionEvidenceGap.length > 0 ||
      toolUseEvidenceGap.length > 0 ||
      contextualIntegrityEvidenceGap.length > 0 ||
      webResearchEvidenceGap.length > 0
        ? ["At least one candidate lacks enough evidence for a confident recommendation."]
        : [
            confidence.level === "confident_recommendation"
              ? "Trial evidence is sufficient for a confident recommendation under the configured threshold."
              : "Trial evidence is sufficient only for a bounded recommendation.",
            ...(faultInjection === undefined
              ? []
              : ["Fault-injection observations are included in the evidence boundary."]),
            ...(toolUse === undefined
              ? []
              : ["Tool-use efficiency is reported separately from final task correctness."]),
            ...(contextualIntegrity === undefined
              ? []
              : [
                  "Contextual-integrity privacy evidence is reported separately from final task utility.",
                ]),
            ...(webResearch === undefined
              ? []
              : [
                  "Web-research source evidence is reported separately from final answer correctness.",
                ]),
            ...(reversibility === undefined
              ? []
              : ["Reversibility metadata is included in the evidence boundary."]),
          ]),
      ...reliabilityCandidates.flatMap((candidate) =>
        candidate.reliability.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
      ),
      ...toolUseCandidates.flatMap((candidate) =>
        candidate.toolUse.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
      ),
      ...contextualIntegrityCandidates.flatMap((candidate) =>
        candidate.contextualIntegrity.warnings.map(
          (warning) => `${candidate.candidateId}: ${warning}`,
        ),
      ),
      ...webResearchCandidates.flatMap((candidate) =>
        candidate.webResearch.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
      ),
    ]),
    recommendations: Object.freeze(
      candidates.map((candidate) => {
        const details = [
          ...(candidate.reliability === undefined
            ? []
            : [
                `reliability pass_rate=${
                  candidate.reliability.passRate === null
                    ? "missing"
                    : candidate.reliability.passRate
                }, consistency=${
                  candidate.reliability.consistency === null
                    ? "missing"
                    : candidate.reliability.consistency
                }, max_failure_severity=${candidate.reliability.maxFailureSeverity}`,
              ]),
          ...(candidate.toolUse === undefined
            ? []
            : [
                `tool_efficiency=${
                  candidate.toolUse.efficiencyScore === null
                    ? "missing"
                    : candidate.toolUse.efficiencyScore
                }, unnecessary_tool_calls=${candidate.toolUse.unnecessaryToolCalls}, budget_violations=${candidate.toolUse.budgetViolations}`,
              ]),
          ...(candidate.contextualIntegrity === undefined
            ? []
            : [
                `contextual_integrity_score=${
                  candidate.contextualIntegrity.contextualIntegrityScore === null
                    ? "missing"
                    : candidate.contextualIntegrity.contextualIntegrityScore
                }, leakage_rate=${candidate.contextualIntegrity.leakageRate}, required_misses=${candidate.contextualIntegrity.requiredDisclosureMissCount}, prohibited_violations=${candidate.contextualIntegrity.prohibitedDisclosureViolationCount}`,
              ]),
          ...(candidate.webResearch === undefined
            ? []
            : [
                `web_research_answer_correct=${candidate.webResearch.answerCorrectRate}, citation_coverage=${candidate.webResearch.citationCoverageRate}, reconciliation_rate=${candidate.webResearch.reconciliationRate}, stale_source_uses=${candidate.webResearch.staleSourceUseCount}`,
              ]),
        ];

        return [`${candidate.candidateId}: ${candidate.recommendation}`, ...details].join("; ");
      }),
    ),
    candidates: Object.freeze(candidates),
    confidence,
    ...(reversibility === undefined ? {} : { reversibility }),
    evidence: Object.freeze({
      traceEventCount,
      artifactCount,
      metricCount,
    }),
    insufficientEvidence: Object.freeze([
      ...insufficientEvidence,
      ...faultInjectionEvidenceGap,
      ...toolUseEvidenceGap,
      ...contextualIntegrityEvidenceGap,
      ...webResearchEvidenceGap,
    ]),
    ...(faultInjection === undefined ? {} : { faultInjection }),
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(contextualIntegrity === undefined ? {} : { contextualIntegrity }),
    ...(webResearch === undefined ? {} : { webResearch }),
  });
}

export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
  const reliabilityCandidates = report.candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & { reliability: BenchmarkReliabilitySummary } =>
      candidate.reliability !== undefined,
  );
  const toolUseCandidates = report.candidates.filter(
    (candidate): candidate is BenchmarkReportCandidate & { toolUse: ToolUseReportSummary } =>
      candidate.toolUse !== undefined,
  );
  const contextualIntegrityCandidates = report.candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & {
      contextualIntegrity: ContextualIntegrityReportSummary;
    } => candidate.contextualIntegrity !== undefined,
  );
  const webResearchCandidates = report.candidates.filter(
    (
      candidate,
    ): candidate is BenchmarkReportCandidate & { webResearch: WebResearchReportSummary } =>
      candidate.webResearch !== undefined,
  );
  const lines = [
    `# Benchmark Report: ${report.benchmarkId}`,
    "",
    `Mission: ${report.missionId}`,
    `Generated: ${report.generatedAt}`,
    `Primary metric: ${report.primaryMetric}`,
    `Confidence: ${report.confidence.level}`,
    `Trials: ${report.confidence.observedTrials}/${report.confidence.configuredTrials}`,
    `minTrials: ${report.confidence.minTrials}`,
    `Smoke: ${report.confidence.smoke ? "yes" : "no"}`,
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
    "| Candidate | Harness | Trials | pass^k | Reversibility | Trace completeness | Confidence | Recommendation |",
    "| --- | --- | ---: | ---: | --- | ---: | --- | --- |",
    ...report.candidates.map(
      (candidate) =>
        `| ${candidate.candidateId} | ${candidate.harnessId} | ${candidate.trialCount} | ${
          candidate.passK === undefined
            ? "missing"
            : `pass^${candidate.passK.k}=${candidate.passK.value}`
        } | ${formatReversibility(candidate.reversibility)} | ${candidate.traceCompleteness} | ${candidate.confidence.level} | ${
          candidate.recommendation
        } |`,
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

  if (report.reversibility !== undefined) {
    lines.push(
      "## Reversibility",
      "",
      `- Trace events with metadata: ${report.reversibility.totalEventCount}`,
      `- Irreversible: ${report.reversibility.irreversibleCount}`,
      `- Reversible with cost: ${report.reversibility.reversibleWithCostCount}`,
      `- Reversible cheap: ${report.reversibility.reversibleCheapCount}`,
      `- Superseded events: ${report.reversibility.supersededEventCount}`,
      "",
    );
  }

  if (toolUseCandidates.length > 0) {
    lines.push(
      "## Tool Use",
      "",
      "| Candidate | Observed / Planned cases | Tool calls | Necessary | Unnecessary | Avoided | Budget violations | Direct-answer opportunities | Efficiency | Cost USD | Latency ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...toolUseCandidates.map((candidate) => {
        const toolUse = candidate.toolUse;
        return `| ${candidate.candidateId} | ${toolUse.observedCaseCount}/${toolUse.plannedCaseCount} | ${toolUse.totalToolCalls} | ${toolUse.necessaryToolCalls} | ${toolUse.unnecessaryToolCalls} | ${toolUse.avoidedToolCalls} | ${toolUse.budgetViolations} | ${toolUse.directAnswerOpportunities} | ${toolUse.efficiencyScore ?? "n/a"} | ${toolUse.totalCostUsd ?? "n/a"} | ${toolUse.totalLatencyMs ?? "n/a"} |`;
      }),
      "",
    );

    const toolUseWarnings = toolUseCandidates.flatMap((candidate) =>
      candidate.toolUse.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
    );
    if (toolUseWarnings.length > 0) {
      lines.push(
        "### Tool Use Warnings",
        "",
        ...toolUseWarnings.map((warning) => `- ${warning}`),
        "",
      );
    }
  }

  if (contextualIntegrityCandidates.length > 0) {
    lines.push(
      "## Contextual Integrity",
      "",
      "| Candidate | Observed / Planned cases | Utility rate | Leakage rate | Required misses | Prohibited violations | Score |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...contextualIntegrityCandidates.map((candidate) => {
        const contextualIntegrity = candidate.contextualIntegrity;
        return `| ${candidate.candidateId} | ${contextualIntegrity.observedCaseCount}/${contextualIntegrity.plannedCaseCount} | ${contextualIntegrity.utilityRate} | ${contextualIntegrity.leakageRate} | ${contextualIntegrity.requiredDisclosureMissCount} | ${contextualIntegrity.prohibitedDisclosureViolationCount} | ${contextualIntegrity.contextualIntegrityScore ?? "n/a"} |`;
      }),
      "",
    );

    const contextualIntegrityWarnings = contextualIntegrityCandidates.flatMap((candidate) =>
      candidate.contextualIntegrity.warnings.map(
        (warning) => `${candidate.candidateId}: ${warning}`,
      ),
    );
    if (contextualIntegrityWarnings.length > 0) {
      lines.push(
        "### Contextual Integrity Warnings",
        "",
        ...contextualIntegrityWarnings.map((warning) => `- ${warning}`),
        "",
      );
    }
  }

  if (webResearchCandidates.length > 0) {
    lines.push(
      "## Web Research",
      "",
      "| Candidate | Observed / Planned cases | Answer correctness | Citation coverage | Reconciliation | Stale source uses | Chinese text preserved |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...webResearchCandidates.map((candidate) => {
        const webResearch = candidate.webResearch;
        return `| ${candidate.candidateId} | ${webResearch.observedCaseCount}/${webResearch.plannedCaseCount} | ${webResearch.answerCorrectRate} | ${webResearch.citationCoverageRate} | ${webResearch.reconciliationRate} | ${webResearch.staleSourceUseCount} | ${webResearch.chineseTextPreservationRate} |`;
      }),
      "",
    );

    const webResearchWarnings = webResearchCandidates.flatMap((candidate) =>
      candidate.webResearch.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
    );
    if (webResearchWarnings.length > 0) {
      lines.push(
        "### Web Research Warnings",
        "",
        ...webResearchWarnings.map((warning) => `- ${warning}`),
        "",
      );
    }
  }

  if (report.confidence.reasons.length > 0) {
    lines.push("## Confidence", "", ...report.confidence.reasons.map((item) => `- ${item}`), "");
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
