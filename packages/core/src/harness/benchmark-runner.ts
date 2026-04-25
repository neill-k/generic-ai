import { randomUUID } from "node:crypto";

import {
  assertCompiledHarness,
  compileHarnessDsl,
  createBenchmarkReport,
  createStableFingerprint,
  type ArtifactReference,
  type BenchmarkReport,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type CompiledHarness,
  type HarnessDsl,
  type MetricValue,
  type MissionSpec,
  type TraceDiagnostics,
  type TraceEvent,
  type TraceEventType,
} from "@generic-ai/sdk";
import { createGenericAILlmRuntime } from "../runtime/llm.js";
import type { CreateGenericAILlmRuntimeOptions, GenericAILlmRuntime } from "../runtime/types.js";

export interface HarnessBenchmarkRuntimeContext {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly candidateId: string;
  readonly trialId: string;
  readonly compiled: CompiledHarness;
  readonly prompt: string;
}

export type HarnessBenchmarkRuntimeFactory = (
  context: HarnessBenchmarkRuntimeContext,
) => Promise<GenericAILlmRuntime>;

export interface RunHarnessBenchmarkOptions {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly harnesses: Readonly<Record<string, HarnessDsl>>;
  readonly createRuntime?: HarnessBenchmarkRuntimeFactory;
  readonly runtimeOptions?: CreateGenericAILlmRuntimeOptions;
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
  readonly compiled: CompiledHarness;
}): string {
  const lines = [
    `Mission ${input.mission.id}`,
    input.mission.objective,
    "",
    `Candidate: ${input.candidateId}`,
    `Compiled harness: ${input.compiled.id}`,
    `Primary metric: ${input.benchmark.primaryMetric}`,
  ];
  const constraints = input.mission.constraints ?? [];
  const expectedArtifacts = input.mission.expectedArtifacts ?? [];

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

  return lines.join("\n");
}

function eventFactory(input: {
  readonly now: () => string;
  readonly runId: string;
  readonly harnessId: string;
  readonly candidateId: string;
  readonly trialId: string;
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
      ...event,
    });
  };
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
  const taskSuccess = substringsPresent && artifactsPresent ? 1 : 0;
  const artifactCompleteness = artifactsPresent ? 1 : 0;
  const diagnostics = traceDiagnostics(input.traceEvents);

  return Object.freeze([
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
      value: 0,
      evidenceRefs: Object.freeze(input.traceEvents.map((event) => event.id)),
    },
    {
      metricId: "handoff_count",
      value: diagnostics.handoffCount,
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
    const instructions =
      options.runtimeOptions.instructions ?? context.compiled.agents[0]?.instructions;
    return createGenericAILlmRuntime({
      ...options.runtimeOptions,
      ...(instructions === undefined ? {} : { instructions }),
    });
  }

  throw new Error("Harness benchmark runs require createRuntime or runtimeOptions.");
}

async function runTrial(input: {
  readonly options: RunHarnessBenchmarkOptions;
  readonly compiled: CompiledHarness;
  readonly candidateId: string;
  readonly trialId: string;
  readonly runId: string;
}): Promise<BenchmarkTrialResult> {
  const startedAt = Date.now();
  const prompt = buildMissionPrompt({
    benchmark: input.options.benchmark,
    mission: input.options.mission,
    candidateId: input.candidateId,
    compiled: input.compiled,
  });
  const runtime = await resolveRuntime(input.options, {
    benchmark: input.options.benchmark,
    mission: input.options.mission,
    candidateId: input.candidateId,
    trialId: input.trialId,
    compiled: input.compiled,
    prompt,
  });
  const createEvent = eventFactory({
    now: input.options.now ?? (() => new Date().toISOString()),
    runId: input.runId,
    harnessId: input.compiled.id,
    candidateId: input.candidateId,
    trialId: input.trialId,
  });
  const traceEvents: TraceEvent[] = [
    createEvent({
      type: "trial.started",
      summary: `Started ${input.candidateId} ${input.trialId}.`,
    }),
    createEvent({
      type: "actor.invoked",
      ...(input.compiled.agents[0]?.id === undefined
        ? {}
        : { actorId: input.compiled.agents[0].id }),
      summary: `Invoked runtime adapter ${runtime.adapter}/${runtime.model}.`,
    }),
  ];

  try {
    const response = await runtime.run(prompt);
    const latencyMs = Date.now() - startedAt;
    const artifact: ArtifactReference = Object.freeze({
      id: `${input.trialId}:assistant-output`,
      kind: "message",
      uri: `memory://${input.runId}/${input.trialId}/assistant-output`,
      sha256: createStableFingerprint(response.outputText),
      redaction: "metadata_only",
      summary: "Assistant final output captured as benchmark evidence.",
    });

    traceEvents.push(
      createEvent({
        type: "actor.completed",
        ...(input.compiled.agents[0]?.id === undefined
          ? {}
          : { actorId: input.compiled.agents[0].id }),
        latencyMs,
        summary: `Runtime completed with adapter ${response.adapter}/${response.model}.`,
      }),
      createEvent({
        type: "artifact.created",
        artifactId: artifact.id,
        payloadRef: artifact,
        summary: "Captured assistant output artifact.",
      }),
      createEvent({
        type: "grader.completed",
        artifactId: artifact.id,
        summary: "Default deterministic graders completed.",
      }),
      createEvent({
        type: "trial.completed",
        summary: `Completed ${input.candidateId} ${input.trialId}.`,
      }),
    );

    const diagnostics = traceDiagnostics(traceEvents);
    return Object.freeze({
      candidateId: input.candidateId,
      harnessId: input.compiled.id,
      trialId: input.trialId,
      metrics: scoreMission({
        mission: input.options.mission,
        outputText: response.outputText,
        traceEvents,
        artifact,
        latencyMs,
      }),
      traceEvents: Object.freeze(traceEvents),
      artifacts: Object.freeze([artifact]),
      diagnostics,
    });
  } finally {
    await runtime.close?.();
  }
}

export async function runHarnessBenchmark(
  options: RunHarnessBenchmarkOptions,
): Promise<RunHarnessBenchmarkResult> {
  if (options.benchmark.missionRef !== options.mission.id) {
    throw new Error(
      `Benchmark missionRef "${options.benchmark.missionRef}" does not match mission "${options.mission.id}".`,
    );
  }

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
  const trialResults: BenchmarkTrialResult[] = [];
  for (let trialIndex = 0; trialIndex < options.benchmark.trials.count; trialIndex += 1) {
    for (const candidate of options.benchmark.candidates) {
      const compiled = compiledHarnesses[candidate.harnessRef];
      if (compiled === undefined) {
        throw new Error(`Compiled harness "${candidate.harnessRef}" was not found.`);
      }
      trialResults.push(
        await runTrial({
          options,
          compiled,
          candidateId: candidate.id,
          trialId: `${candidate.id}:trial:${trialIndex + 1}`,
          runId,
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
    }),
    compiledHarnesses: Object.freeze(compiledHarnesses),
    trialResults: Object.freeze(trialResults),
  });
}
