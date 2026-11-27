import { randomUUID } from "node:crypto";

import {
  type ArtifactReference,
  assertCompiledHarness,
  type BenchmarkReport,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type BenchmarkUsageObservation,
  type CanonicalEvent,
  type CompiledHarness,
  compileHarnessDsl,
  createBenchmarkReport,
  createStableFingerprint,
  describeGoalForAgent,
  type GoalTraceEntry,
  type GoalValidationReport,
  goalTraceFromCanonicalEvents,
  type HarnessDsl,
  type MetricValue,
  type MissionSpec,
  normalizeToolError,
  type ProtocolPlugin,
  type RunGoalValidatorsOptions,
  runGoalValidators,
  type SealedGoal,
  sealGoal,
  summarizeUsageEvents,
  type ToolRecoveryObservation,
  type TraceDiagnostics,
  type TraceEvent,
  type TraceEventType,
} from "@generic-ai/sdk";
import { createGenericAILlmRuntime } from "../runtime/llm.js";
import type { CreateGenericAILlmRuntimeOptions, GenericAILlmRuntime } from "../runtime/types.js";
import { goalTraceFromTopologyOutcomes } from "./goal-eval-executor.js";
import { runHarnessTopology, type TopologyActorRunner } from "./topology-runner.js";

export interface HarnessBenchmarkRuntimeContext {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly candidateId: string;
  readonly trialId: string;
  readonly seed?: string;
  readonly replayId: string;
  readonly compiled: CompiledHarness;
  readonly prompt: string;
}

export type HarnessBenchmarkRuntimeFactory = (
  context: HarnessBenchmarkRuntimeContext,
) => Promise<GenericAILlmRuntime>;

export type HarnessBenchmarkActorRunnerFactory = (
  context: HarnessBenchmarkRuntimeContext,
) => TopologyActorRunner | Promise<TopologyActorRunner>;

export interface HarnessBenchmarkTopologyOptions {
  readonly protocol?: string;
  readonly protocols?: readonly ProtocolPlugin[];
  readonly maxSteps?: number;
  readonly maxConcurrency?: number;
  readonly maxAttempts?: number;
}

export interface RunHarnessBenchmarkOptions {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly harnesses: Readonly<Record<string, HarnessDsl>>;
  readonly createRuntime?: HarnessBenchmarkRuntimeFactory;
  readonly runtimeOptions?: CreateGenericAILlmRuntimeOptions;
  /**
   * Runs candidates through their protocol topology instead of sending one
   * prompt to one model. Used for every candidate whose harness declares a
   * protocol binding; candidates without one still use the runtime.
   */
  readonly createActorRunner?: HarnessBenchmarkActorRunnerFactory;
  readonly topology?: HarnessBenchmarkTopologyOptions;
  /** Judges and checks for the mission goal's validators. */
  readonly goalValidation?: Pick<
    RunGoalValidatorsOptions,
    "judges" | "checks" | "defaultTimeoutMs"
  >;
  readonly now?: () => string;
}

export interface RunHarnessBenchmarkResult {
  readonly report: BenchmarkReport;
  readonly compiledHarnesses: Readonly<Record<string, CompiledHarness>>;
  readonly trialResults: readonly BenchmarkTrialResult[];
}

function requireHarness(
  harnesses: Readonly<Record<string, HarnessDsl>>,
  harnessRef: string,
): HarnessDsl {
  const harness = harnesses[harnessRef];
  if (harness === undefined) {
    throw new Error(`Benchmark references missing harness "${harnessRef}".`);
  }
  return harness;
}

function buildMissionPrompt(input: {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly candidateId: string;
  readonly trialId: string;
  readonly seed?: string;
  readonly replayId: string;
  readonly compiled: CompiledHarness;
  readonly goal?: SealedGoal;
}): string {
  const lines = [
    `Mission ${input.mission.id}`,
    input.mission.objective,
    "",
    `Candidate: ${input.candidateId}`,
    `Trial: ${input.trialId}`,
    `Replay id: ${input.replayId}`,
    ...(input.seed === undefined ? [] : [`Seed: ${input.seed}`]),
    `Compiled harness: ${input.compiled.id}`,
    `Primary metric: ${input.benchmark.primaryMetric}`,
  ];
  const constraints = input.mission.constraints ?? [];
  const expectedArtifacts = input.mission.expectedArtifacts ?? [];
  const faultInjections = input.benchmark.faultInjections ?? [];

  if (constraints.length > 0) {
    lines.push("", "Constraints:", ...constraints.map((constraint) => `- ${constraint}`));
  }

  if (expectedArtifacts.length > 0) {
    lines.push(
      "",
      "Expected artifacts:",
      ...expectedArtifacts.map((artifact) => `- ${artifact.name} (${artifact.kind})`),
    );
  }

  if (input.goal !== undefined) {
    lines.push("", describeGoalForAgent(input.goal));
  }

  if (faultInjections.length > 0) {
    lines.push(
      "",
      "Fault injections:",
      ...faultInjections.map((fault) => {
        const details = [
          `boundary=${fault.boundary}`,
          `perturbation=${fault.perturbation}`,
          `target=${fault.targetRef}`,
          `expected=${fault.expectedBehavior}`,
          ...(fault.firstViolatedContract === undefined
            ? []
            : [`first violated contract=${fault.firstViolatedContract}`]),
        ].join(", ");
        return `- ${fault.id}: ${details}`;
      }),
    );
  }

  return lines.join("\n");
}

function eventFactory(input: {
  readonly now: () => string;
  readonly runId: string;
  readonly harnessId: string;
  readonly candidateId: string;
  readonly trialId: string;
  readonly seed?: string;
  readonly replayId: string;
}): (event: Omit<TraceEvent, "id" | "sequence" | "timestamp" | "runId">) => TraceEvent {
  let sequence = 0;

  return (event) => {
    sequence += 1;
    return Object.freeze({
      id: `${input.runId}:${input.trialId}:event:${sequence}`,
      sequence,
      timestamp: input.now(),
      runId: input.runId,
      harnessId: input.harnessId,
      candidateId: input.candidateId,
      trialId: input.trialId,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      replayId: input.replayId,
      ...event,
    });
  };
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

function validatePositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Benchmark ${name} must be a positive integer.`);
  }
}

function validateBenchmarkTrialConfig(benchmark: BenchmarkSpec): void {
  validatePositiveInteger("trials.count", benchmark.trials?.count);
  validatePositiveInteger("trials.minTrials", benchmark.trials?.minTrials);
  validatePositiveInteger("trials.passK", benchmark.trials?.passK);
  validatePositiveInteger("minTrials", benchmark.minTrials);
  validatePositiveInteger(
    "validity.minimumTrialsForRecommendation",
    benchmark.validity?.minimumTrialsForRecommendation,
  );
}

function trialSeed(benchmark: BenchmarkSpec, trialIndex: number): string | undefined {
  const seed = benchmark.trials?.seed;
  return seed === undefined ? undefined : `${seed}:${trialIndex + 1}`;
}

function memoryArtifactUri(...segments: readonly string[]): string {
  return `memory:///${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function traceDiagnostics(events: readonly TraceEvent[]): TraceDiagnostics {
  const required: readonly TraceEventType[] = [
    "trial.started",
    "actor.invoked",
    "actor.completed",
    "artifact.created",
    "grader.completed",
    "trial.completed",
  ];
  const present = new Set(events.map((event) => event.type));
  const missing = required.filter((type) => !present.has(type));
  const handoffCount = events.filter((event) => event.type === "protocol.action.planned").length;
  const policyDecisionCount = events.filter((event) => event.type === "policy.decision").length;
  const artifactCount = events.filter((event) => event.type === "artifact.created").length;

  return Object.freeze({
    completeness: (required.length - missing.length) / required.length,
    missingRequiredEventTypes: Object.freeze(missing),
    handoffCount,
    reworkCount: 0,
    policyDecisionCount,
    artifactCount,
  });
}

function scoreMission(input: {
  readonly mission: MissionSpec;
  readonly outputText: string;
  readonly traceEvents: readonly TraceEvent[];
  readonly artifact: ArtifactReference;
  readonly latencyMs: number;
  readonly runSucceeded: boolean;
  readonly goalReport?: GoalValidationReport;
  readonly costUsd: number;
}): readonly MetricValue[] {
  const requiredSubstrings = input.mission.successCriteria?.requiredSubstrings ?? [];
  const requiredArtifactNames = [
    ...(input.mission.expectedArtifacts ?? []).map((artifact) => artifact.name),
    ...(input.mission.successCriteria?.requiredArtifacts ?? []),
  ].filter((name, index, names) => names.indexOf(name) === index);
  const substringsPresent =
    requiredSubstrings.length === 0 ||
    requiredSubstrings.every((substring) => input.outputText.includes(substring));
  const artifactsPresent =
    requiredArtifactNames.length === 0 ||
    requiredArtifactNames.every((name) => input.outputText.includes(name));
  const goalComplete = input.goalReport === undefined || input.goalReport.complete;
  const taskSuccess =
    input.runSucceeded && substringsPresent && artifactsPresent && goalComplete ? 1 : 0;
  const artifactCompleteness = artifactsPresent ? 1 : 0;
  const diagnostics = traceDiagnostics(input.traceEvents);
  const goalMetrics: MetricValue[] =
    input.goalReport === undefined
      ? []
      : [
          {
            metricId: "goal_complete",
            value: input.goalReport.complete ? 1 : 0,
            evidenceRefs: Object.freeze([input.artifact.id]),
          },
          {
            metricId: "goal_validators_passed",
            value:
              input.goalReport.results.length === 0
                ? 0
                : input.goalReport.summary.passed / input.goalReport.results.length,
            evidenceRefs: Object.freeze([input.artifact.id]),
          },
        ];

  return Object.freeze([
    ...goalMetrics,
    {
      metricId: "task_success",
      value: taskSuccess,
      evidenceRefs: Object.freeze([input.artifact.id]),
    },
    {
      metricId: "artifact_completeness",
      value: artifactCompleteness,
      evidenceRefs: Object.freeze([input.artifact.id]),
    },
    {
      metricId: "tests_passed",
      value: taskSuccess,
      evidenceRefs: Object.freeze([input.artifact.id]),
    },
    {
      metricId: "trace_completeness",
      value: diagnostics.completeness,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "wall_time",
      value: input.latencyMs / 1000,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "cost_usd",
      value: input.costUsd,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "handoff_count",
      value: diagnostics.handoffCount,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "rework_count",
      value: diagnostics.reworkCount,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "rework_rate",
      value: diagnostics.reworkCount / Math.max(1, diagnostics.handoffCount),
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "policy_violations",
      value: 0,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
  ]);
}

async function resolveRuntime(
  options: RunHarnessBenchmarkOptions,
  context: HarnessBenchmarkRuntimeContext,
): Promise<GenericAILlmRuntime> {
  if (options.createRuntime !== undefined) {
    return options.createRuntime(context);
  }

  if (options.runtimeOptions !== undefined) {
    const primaryAgent = context.compiled.agents[0];
    const instructions = options.runtimeOptions.instructions ?? primaryAgent?.instructions;
    const model = options.runtimeOptions.model ?? primaryAgent?.model;
    return createGenericAILlmRuntime({
      ...options.runtimeOptions,
      ...(model === undefined ? {} : { model }),
      ...(instructions === undefined ? {} : { instructions }),
    });
  }

  throw new Error("Harness benchmark runs require createRuntime or runtimeOptions.");
}

interface TrialExecution {
  readonly outputText: string;
  readonly runSucceeded: boolean;
  readonly artifactSummary: string;
  readonly completedSummary: string;
  readonly events: readonly CanonicalEvent[];
  readonly extraTrace: readonly GoalTraceEntry[];
  readonly toolRecovery: readonly ToolRecoveryObservation[];
  readonly costUsd?: number;
}

type CreateTraceEvent = (
  event: Omit<TraceEvent, "id" | "sequence" | "timestamp" | "runId">,
) => TraceEvent;

function failureExecution(input: {
  readonly error: unknown;
  readonly trialId: string;
  readonly toolRef: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createEvent: CreateTraceEvent;
  readonly traceEvents: TraceEvent[];
}): TrialExecution {
  const artifactSummary = `Runtime failed: ${input.error instanceof Error ? input.error.message : String(input.error)}`;
  const diagnostic = input.createEvent({ type: "diagnostic", summary: artifactSummary });
  input.traceEvents.push(diagnostic);
  return {
    outputText: "",
    runSucceeded: false,
    artifactSummary,
    completedSummary: artifactSummary,
    events: [],
    extraTrace: [],
    toolRecovery: [
      Object.freeze({
        caseRef: "runtime.run",
        attemptRef: `${input.trialId}:runtime-run`,
        toolRef: input.toolRef,
        status: "failed",
        error: normalizeToolError({
          error: input.error,
          safeMessage: artifactSummary,
          metadata: input.metadata,
        }),
        evidenceRefs: Object.freeze([diagnostic.id]),
      }),
    ],
  };
}

async function executeRuntimeTrial(input: {
  readonly options: RunHarnessBenchmarkOptions;
  readonly context: HarnessBenchmarkRuntimeContext;
  readonly trialId: string;
  readonly createEvent: CreateTraceEvent;
  readonly traceEvents: TraceEvent[];
}): Promise<TrialExecution> {
  const runtime = await resolveRuntime(input.options, input.context);
  try {
    input.traceEvents.push(
      input.createEvent({
        type: "actor.invoked",
        ...(input.context.compiled.agents[0]?.id === undefined
          ? {}
          : { actorId: input.context.compiled.agents[0].id }),
        summary: `Invoked runtime adapter ${runtime.adapter}/${runtime.model}.`,
      }),
    );
    const startedAt = Date.now();
    let execution: TrialExecution;
    try {
      const response = await runtime.run(input.context.prompt);
      execution = {
        outputText: response.outputText,
        runSucceeded: true,
        artifactSummary: "Assistant final output captured as benchmark evidence.",
        completedSummary: `Runtime completed with adapter ${response.adapter}/${response.model}.`,
        events: [],
        extraTrace: [],
        toolRecovery: [],
      };
    } catch (error) {
      execution = failureExecution({
        error,
        trialId: input.trialId,
        toolRef: "runtime.adapter",
        metadata: { adapter: runtime.adapter, model: runtime.model },
        createEvent: input.createEvent,
        traceEvents: input.traceEvents,
      });
    }
    input.traceEvents.push(
      input.createEvent({
        type: "actor.completed",
        ...(input.context.compiled.agents[0]?.id === undefined
          ? {}
          : { actorId: input.context.compiled.agents[0].id }),
        latencyMs: Date.now() - startedAt,
        summary: execution.completedSummary,
      }),
    );
    return execution;
  } finally {
    await runtime.close?.();
  }
}

async function executeTopologyTrial(input: {
  readonly options: RunHarnessBenchmarkOptions;
  readonly createActorRunner: HarnessBenchmarkActorRunnerFactory;
  readonly context: HarnessBenchmarkRuntimeContext;
  readonly runId: string;
  readonly trialId: string;
  readonly createEvent: CreateTraceEvent;
  readonly traceEvents: TraceEvent[];
}): Promise<TrialExecution> {
  const topology = input.options.topology ?? {};
  try {
    const runner = await input.createActorRunner(input.context);
    const result = await runHarnessTopology({
      compiled: input.context.compiled,
      instruction: input.context.prompt,
      runner,
      runId: `${input.runId}:${input.trialId}`,
      ...(topology.protocol === undefined ? {} : { protocol: topology.protocol }),
      ...(topology.protocols === undefined ? {} : { protocols: topology.protocols }),
      ...(topology.maxSteps === undefined ? {} : { maxSteps: topology.maxSteps }),
      ...(topology.maxConcurrency === undefined ? {} : { maxConcurrency: topology.maxConcurrency }),
      ...(topology.maxAttempts === undefined ? {} : { maxAttempts: topology.maxAttempts }),
    });
    // Re-stamp the topology's own trace into the trial's trace so handoffs,
    // actor invocations, and policy decisions count as benchmark evidence.
    for (const event of result.trace) {
      input.traceEvents.push(
        input.createEvent({
          type: event.type,
          ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
          ...(event.protocolId === undefined ? {} : { protocolId: event.protocolId }),
          ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
          ...(event.policyDecisionId === undefined
            ? {}
            : { policyDecisionId: event.policyDecisionId }),
          summary: event.summary,
        }),
      );
    }
    const succeeded = result.status === "succeeded";
    const summary = succeeded
      ? `Topology ${result.protocol} completed in ${result.steps} step(s).`
      : `Topology ${result.protocol} ended ${result.status}: ${result.failureMessage ?? "no detail"}`;
    if (!succeeded) {
      input.traceEvents.push(input.createEvent({ type: "diagnostic", summary }));
    }
    return {
      outputText: result.outputText,
      runSucceeded: succeeded,
      artifactSummary: succeeded
        ? "Topology final output captured as benchmark evidence."
        : summary,
      completedSummary: summary,
      events: result.events,
      extraTrace: goalTraceFromTopologyOutcomes(result.outcomes),
      toolRecovery: [],
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (error) {
    return failureExecution({
      error,
      trialId: input.trialId,
      toolRef: "topology.runner",
      metadata: { harness: input.context.compiled.id },
      createEvent: input.createEvent,
      traceEvents: input.traceEvents,
    });
  }
}

function usageObservation(
  events: readonly CanonicalEvent[],
  goalCompleted: boolean,
): BenchmarkUsageObservation | undefined {
  if (!events.some((event) => event.name === "usage.recorded")) {
    return undefined;
  }
  const summary = summarizeUsageEvents(events);
  return Object.freeze({
    totalTokens: summary.totals.totalTokens,
    inputTokens: summary.totals.inputTokens,
    outputTokens: summary.totals.outputTokens,
    cacheReadTokens: summary.totals.cacheReadTokens,
    cacheWriteTokens: summary.totals.cacheWriteTokens,
    costUsd: summary.totals.costUsd,
    responses: summary.totals.responses,
    goalsAttempted: 1,
    goalsCompleted: goalCompleted ? 1 : 0,
    ...(events.some((event) => event.name === "usage.budget.exceeded")
      ? { budgetStopped: true }
      : {}),
  });
}

async function runTrial(input: {
  readonly options: RunHarnessBenchmarkOptions;
  readonly compiled: CompiledHarness;
  readonly candidateId: string;
  readonly trialId: string;
  readonly seed?: string;
  readonly replayId: string;
  readonly runId: string;
  readonly goal?: SealedGoal;
}): Promise<BenchmarkTrialResult> {
  const startedAt = Date.now();
  const prompt = buildMissionPrompt({
    benchmark: input.options.benchmark,
    mission: input.options.mission,
    candidateId: input.candidateId,
    trialId: input.trialId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    replayId: input.replayId,
    compiled: input.compiled,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
  });
  const context: HarnessBenchmarkRuntimeContext = {
    benchmark: input.options.benchmark,
    mission: input.options.mission,
    candidateId: input.candidateId,
    trialId: input.trialId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    replayId: input.replayId,
    compiled: input.compiled,
    prompt,
  };
  const createEvent = eventFactory({
    now: input.options.now ?? (() => new Date().toISOString()),
    runId: input.runId,
    harnessId: input.compiled.id,
    candidateId: input.candidateId,
    trialId: input.trialId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    replayId: input.replayId,
  });
  const traceEvents: TraceEvent[] = [
    createEvent({
      type: "trial.started",
      summary: `Started ${input.candidateId} ${input.trialId}.`,
    }),
  ];

  const createActorRunner = input.options.createActorRunner;
  const execution =
    createActorRunner !== undefined && input.compiled.protocols.length > 0
      ? await executeTopologyTrial({
          options: input.options,
          createActorRunner,
          context,
          runId: input.runId,
          trialId: input.trialId,
          createEvent,
          traceEvents,
        })
      : await executeRuntimeTrial({
          options: input.options,
          context,
          trialId: input.trialId,
          createEvent,
          traceEvents,
        });

  const latencyMs = Date.now() - startedAt;
  const artifact: ArtifactReference = Object.freeze({
    id: `${input.trialId}:assistant-output`,
    kind: "message",
    uri: memoryArtifactUri(input.runId, input.trialId, "assistant-output"),
    sha256: createStableFingerprint(execution.outputText),
    redaction: "metadata_only",
    summary: execution.artifactSummary,
  });

  const goalReport =
    input.goal === undefined
      ? undefined
      : await runGoalValidators(
          input.goal,
          {
            outputText: execution.outputText,
            trace: [...goalTraceFromCanonicalEvents(execution.events), ...execution.extraTrace],
          },
          input.options.goalValidation ?? {},
        );

  traceEvents.push(
    createEvent({
      type: "artifact.created",
      artifactId: artifact.id,
      payloadRef: artifact,
      summary: "Captured assistant output artifact.",
    }),
    createEvent({
      type: "grader.completed",
      artifactId: artifact.id,
      summary:
        goalReport === undefined
          ? "Default deterministic graders completed."
          : `Goal ${goalReport.goalId} validators: ${goalReport.status}.`,
    }),
    createEvent({
      type: "trial.completed",
      summary: `Completed ${input.candidateId} ${input.trialId}.`,
    }),
  );

  const usage = usageObservation(execution.events, goalReport?.complete ?? execution.runSucceeded);
  const costUsd = execution.costUsd ?? usage?.costUsd ?? 0;
  const diagnostics = traceDiagnostics(traceEvents);
  return Object.freeze({
    candidateId: input.candidateId,
    harnessId: input.compiled.id,
    trialId: input.trialId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    replayId: input.replayId,
    metrics: scoreMission({
      mission: input.options.mission,
      outputText: execution.outputText,
      traceEvents,
      artifact,
      latencyMs,
      runSucceeded: execution.runSucceeded,
      ...(goalReport === undefined ? {} : { goalReport }),
      costUsd,
    }),
    traceEvents: Object.freeze(traceEvents),
    artifacts: Object.freeze([artifact]),
    diagnostics,
    ...(execution.toolRecovery.length === 0
      ? {}
      : { toolRecovery: Object.freeze([...execution.toolRecovery]) }),
    ...(usage === undefined ? {} : { usage }),
  });
}

export async function runHarnessBenchmark(
  options: RunHarnessBenchmarkOptions,
): Promise<RunHarnessBenchmarkResult> {
  if (options.benchmark.missionRef !== options.mission.id) {
    throw new Error(
      `Benchmark missionRef "${options.benchmark.missionRef}" does not match mission "${options.mission.id}".`,
    );
  }
  validateBenchmarkTrialConfig(options.benchmark);

  const compiledHarnesses: Record<string, CompiledHarness> = {};
  for (const candidate of options.benchmark.candidates) {
    const harness = requireHarness(options.harnesses, candidate.harnessRef);
    compiledHarnesses[candidate.harnessRef] = assertCompiledHarness(compileHarnessDsl(harness));
  }

  const runFingerprint = createStableFingerprint({
    mission: options.mission.id,
    benchmark: options.benchmark.id,
  }).slice(0, 12);
  const runId = `${options.benchmark.id}:${runFingerprint}:${randomUUID()}`;
  const goal = options.mission.goal === undefined ? undefined : sealGoal(options.mission.goal);
  const trialResults: BenchmarkTrialResult[] = [];
  for (let trialIndex = 0; trialIndex < configuredTrialCount(options.benchmark); trialIndex += 1) {
    for (const candidate of options.benchmark.candidates) {
      const compiled = compiledHarnesses[candidate.harnessRef];
      if (compiled === undefined) {
        throw new Error(`Compiled harness "${candidate.harnessRef}" was not found.`);
      }
      const trialId = `${candidate.id}:trial:${trialIndex + 1}`;
      const seed = trialSeed(options.benchmark, trialIndex);
      trialResults.push(
        await runTrial({
          options,
          compiled,
          candidateId: candidate.id,
          trialId,
          ...(seed === undefined ? {} : { seed }),
          replayId: options.benchmark.trials?.replayId ?? `${runId}:${trialId}`,
          runId,
          ...(goal === undefined ? {} : { goal }),
        }),
      );
    }
  }

  return Object.freeze({
    report: createBenchmarkReport({
      benchmark: options.benchmark,
      mission: options.mission,
      generatedAt: options.now?.() ?? new Date().toISOString(),
      results: trialResults,
      capabilityBOMs: options.benchmark.candidates.flatMap((candidate) => {
        const compiled = compiledHarnesses[candidate.harnessRef];
        return compiled === undefined ? [] : [compiled.capabilityBOM];
      }),
    }),
    compiledHarnesses: Object.freeze(compiledHarnesses),
    trialResults: Object.freeze(trialResults),
  });
}
