import { describe, expect, it } from "vitest";
import {
  compileHarnessDsl,
  createPipelineProtocol,
  createSquadProtocol,
  createBenchmarkReport,
  getAgentHarnessToolReversibility,
  HARNESS_SCHEMA_VERSION,
  renderBenchmarkReportMarkdown,
  withAgentHarnessToolEffects,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type HarnessDsl,
  type MissionSpec,
} from "./index.js";

const harness: HarnessDsl = {
  kind: "generic-ai.harness",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "harness.verifier-loop",
  packages: [
    {
      id: "protocol.verifier-loop",
      package: "@generic-ai/protocol-verifier-loop",
      version: "0.1.0",
    },
  ],
  agents: [
    {
      id: "solver",
      role: "solver",
      packageRefs: ["protocol.verifier-loop"],
    },
    {
      id: "critic",
      role: "critic",
      packageRefs: ["protocol.verifier-loop"],
    },
  ],
  spaces: [
    {
      id: "shared-workspace",
      kind: "workspace",
      visibility: "shared",
    },
  ],
  protocols: [
    {
      id: "verifier-loop",
      protocol: "verifier-loop",
      packageRef: "protocol.verifier-loop",
      actorRefs: ["solver", "critic"],
    },
  ],
};

const mission: MissionSpec = {
  kind: "generic-ai.mission",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "mission.docs",
  objective: "Improve the public README.",
  objectiveClass: "coding",
};

const benchmark: BenchmarkSpec = {
  kind: "generic-ai.benchmark",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "benchmark.docs",
  missionRef: mission.id,
  hypothesis: "Verifier loop improves README quality.",
  candidates: [
    {
      id: "verifier-loop",
      harnessRef: harness.id,
    },
  ],
  primaryMetric: "task_success",
  trials: {
    count: 1,
    pairing: "paired",
  },
};

const pipelineHarness: HarnessDsl = {
  kind: "generic-ai.harness",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "harness.pipeline",
  packages: [
    {
      id: "protocol.pipeline",
      package: "@generic-ai/protocol-pipeline",
      version: "0.1.0",
    },
  ],
  agents: [
    {
      id: "implementer",
      role: "implementer",
      packageRefs: ["protocol.pipeline"],
    },
  ],
  protocols: [
    {
      id: "pipeline",
      protocol: "pipeline",
      packageRef: "protocol.pipeline",
      actorRefs: ["implementer"],
    },
  ],
};

describe("Harness DSL compiler", () => {
  it("compiles deterministic IR with fingerprints", () => {
    const first = compileHarnessDsl(harness);
    const second = compileHarnessDsl(harness);

    expect(first.diagnostics).toEqual([]);
    expect(first.compiled?.sourceId).toBe(harness.id);
    expect(first.compiled?.fingerprint).toEqual(second.compiled?.fingerprint);
    expect(first.compiled?.agents.map((agent) => agent.id)).toEqual(["solver", "critic"]);
  });

  it("reports missing references before runtime execution", () => {
    const result = compileHarnessDsl({
      ...harness,
      protocols: [
        {
          id: "broken",
          protocol: "pipeline",
          packageRef: "missing-package",
          actorRefs: ["ghost"],
        },
      ],
    });

    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "missing_package",
      "missing_agent",
    ]);
  });

  it("validates agent capability references before runtime execution", () => {
    const result = compileHarnessDsl({
      ...harness,
      agents: [
        {
          id: "solver",
          role: "solver",
          packageRefs: ["protocol.verifier-loop"],
          capabilityRefs: ["missing-capability"],
        },
        {
          id: "critic",
          role: "critic",
          packageRefs: ["protocol.verifier-loop"],
        },
      ],
    });

    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_capability");
  });

  it("validates agent artifact references before runtime execution", () => {
    const result = compileHarnessDsl({
      ...harness,
      artifacts: [
        {
          id: "artifact.readme",
          name: "README.md",
          kind: "file",
        },
      ],
      agents: [
        {
          id: "solver",
          role: "solver",
          packageRefs: ["protocol.verifier-loop"],
          artifactRefs: ["missing-artifact"],
        },
        {
          id: "critic",
          role: "critic",
          packageRefs: ["protocol.verifier-loop"],
        },
      ],
    });

    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_artifact");
  });
});

describe("standard protocol planners", () => {
  it("plans deterministic protocol actions without side effects", async () => {
    const compiled = compileHarnessDsl(harness).compiled;
    expect(compiled).toBeDefined();

    const pipeline = createPipelineProtocol();
    const squad = createSquadProtocol();
    const noSharedSpaceCompiled = compileHarnessDsl({
      ...harness,
      id: "harness.no-shared-space",
      spaces: [],
    }).compiled;
    const pipelineCompiled = compileHarnessDsl(pipelineHarness).compiled;
    if (compiled === undefined) {
      throw new Error("Expected the squad harness fixture to compile.");
    }
    if (pipelineCompiled === undefined) {
      throw new Error("Expected the pipeline harness fixture to compile.");
    }
    if (noSharedSpaceCompiled === undefined) {
      throw new Error("Expected the no-shared-space harness fixture to compile.");
    }

    const missingImplementerDiagnostics = await pipeline.validate?.(compiled);
    const pipelineResult = await pipeline.reduce({
      compiled: pipelineCompiled,
      state: { status: "ready" },
      events: [],
    });
    const squadDiagnostics = await squad.validate?.(compiled);
    const noSharedSpaceDiagnostics = await squad.validate?.(noSharedSpaceCompiled);

    expect(pipelineResult.actions[0]?.kind).toBe("invoke_actor");
    expect(pipelineResult.actions[0]?.actorRef).toBe("implementer");
    expect(pipelineResult.summary.status).toBe("ready");
    expect(missingImplementerDiagnostics?.[0]?.code).toBe("missing_protocol_actor");
    expect(squadDiagnostics).toEqual([]);
    expect(noSharedSpaceDiagnostics?.[0]?.code).toBe("missing_shared_space");
  });
});

describe("tool effect descriptors", () => {
  it("keeps reversibility metadata next to declared authority effects", () => {
    const tool = withAgentHarnessToolEffects(
      {
        name: "write_file",
      },
      {
        id: "files.write",
        effects: ["fs.write"],
        reversibility: "irreversible",
        retrySemantics: "retry-may-duplicate",
      },
    );

    expect(tool.genericAi?.effects).toEqual(["fs.write"]);
    expect(getAgentHarnessToolReversibility(tool)).toBe("irreversible");
    expect(tool.genericAi?.descriptor?.retrySemantics).toBe("retry-may-duplicate");
  });
});

describe("Benchmark reports", () => {
  it("separates observations, inferences, recommendations, and insufficient evidence", () => {
    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        {
          candidateId: "verifier-loop",
          harnessId: "harness.verifier-loop:compiled",
          trialId: "trial-1",
          metrics: [
            {
              metricId: "task_success",
              value: 1,
              evidenceRefs: ["artifact-1"],
            },
          ],
          traceEvents: [],
          artifacts: [],
          diagnostics: {
            completeness: 0,
            missingRequiredEventTypes: [],
            handoffCount: 0,
            reworkCount: 0,
            policyDecisionCount: 0,
            artifactCount: 0,
          },
        } satisfies BenchmarkTrialResult,
      ],
    });

    expect(report.observations[0]).toContain("trace events");
    expect(report.insufficientEvidence[0]).toContain("verifier-loop");
    expect(report.confidence.level).toBe("insufficient_evidence");
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Recommendations");
    expect(renderBenchmarkReportMarkdown(report)).toContain("pass^");
  });

  it("reports pass^k reliability and confidence for repeated trials", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        minTrials: 5,
        trials: {
          count: 5,
          pairing: "paired",
          seed: "docs-v0",
          passK: 5,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [1, 0, 1, 0, 0].map((value, index) => ({
        ...trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", value),
        trialId: `verifier-loop:trial-${index + 1}`,
      })),
    });

    expect(report.confidence.level).toBe("confident_recommendation");
    expect(report.candidates[0]?.passK?.k).toBe(5);
    expect(report.candidates[0]?.passK?.passCount).toBe(2);
    expect(report.candidates[0]?.passK?.value).toBeCloseTo(0.92224);
    expect(renderBenchmarkReportMarkdown(report)).toContain("Confidence: confident_recommendation");
  });

  it("lets smoke checks stay bounded instead of confident", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        smoke: true,
        minTrials: 1,
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1)],
    });

    expect(report.candidates[0]?.recommendation).toBe("recommended");
    expect(report.confidence.level).toBe("bounded_recommendation");
    expect(report.confidence.reasons[0]).toContain("smoke");
  });

  it("does not let legacy single-run overrides bypass explicit minTrials", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        minTrials: 3,
        validity: {
          minimumTrialsForRecommendation: 1,
          allowSingleRunRecommendation: true,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1)],
    });

    expect(report.candidates[0]?.recommendation).toBe("insufficient_evidence");
    expect(report.confidence.level).toBe("insufficient_evidence");
    expect(report.insufficientEvidence[0]).toContain("minTrials: 3");
  });

  it("honors lower-is-better primary metrics and compiled harness ids", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        primaryMetric: "wall_time",
        metricDefinitions: [
          {
            id: "wall_time",
            name: "Wall time",
            unit: "seconds",
            direction: "lower_is_better",
            source: "runtime",
          },
        ],
        candidates: [
          {
            id: "slow",
            harnessRef: "harness.slow",
          },
          {
            id: "fast",
            harnessRef: "harness.fast",
          },
        ],
        validity: {
          minimumTrialsForRecommendation: 1,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        trialResult("slow", "harness.slow:compiled", "wall_time", 10),
        trialResult("fast", "harness.fast:compiled", "wall_time", 2),
      ],
    });

    expect(
      report.candidates.find((candidate) => candidate.candidateId === "fast")?.recommendation,
    ).toBe("recommended");
    expect(
      report.candidates.find((candidate) => candidate.candidateId === "slow")?.recommendation,
    ).toBe("not_recommended");
    expect(report.candidates.find((candidate) => candidate.candidateId === "fast")?.harnessId).toBe(
      "harness.fast:compiled",
    );
  });

  it("requires multi-agent candidates to clear the single-agent baseline delta", () => {
    const report = createBenchmarkReport({
      benchmark: singleAgentBaselineBenchmark(),
      mission,
      generatedAt: "2026-05-03T00:00:00.000Z",
      results: [
        baselineTrial("single-agent-baseline", 0.8, 1, 100, 0),
        baselineTrial("verifier-loop", 0.9, 1.8, 140, 2),
        baselineTrial("hierarchy", 0.82, 1.4, 125, 3),
      ],
    });
    const baseline = report.candidates.find(
      (candidate) => candidate.candidateId === "single-agent-baseline",
    );
    const verifierLoop = report.candidates.find(
      (candidate) => candidate.candidateId === "verifier-loop",
    );
    const hierarchy = report.candidates.find((candidate) => candidate.candidateId === "hierarchy");
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(report.singleAgentBaseline?.baselineCandidateId).toBe("single-agent-baseline");
    expect(verifierLoop?.singleAgentBaselineComparison?.outcome).toBe("beats_baseline");
    expect(verifierLoop?.singleAgentBaselineComparison?.delta).toBeCloseTo(0.1);
    expect(verifierLoop?.recommendation).toBe("recommended");
    expect(hierarchy?.singleAgentBaselineComparison?.outcome).toBe("within_threshold");
    expect(hierarchy?.recommendation).toBe("not_recommended");
    expect(baseline?.recommendation).toBe("not_recommended");
    expect(markdown).toContain("## Single-Agent Baseline");
    expect(markdown).toContain("single_agent_baseline=beats_baseline");
  });

  it("recommends the single-agent baseline when no multi-agent candidate clears the delta", () => {
    const report = createBenchmarkReport({
      benchmark: singleAgentBaselineBenchmark(),
      mission,
      generatedAt: "2026-05-03T00:00:00.000Z",
      results: [
        baselineTrial("single-agent-baseline", 0.9, 1, 100, 0),
        baselineTrial("verifier-loop", 0.92, 1.8, 140, 2),
      ],
    });
    const baseline = report.candidates.find(
      (candidate) => candidate.candidateId === "single-agent-baseline",
    );
    const verifierLoop = report.candidates.find(
      (candidate) => candidate.candidateId === "verifier-loop",
    );

    expect(verifierLoop?.singleAgentBaselineComparison?.outcome).toBe("within_threshold");
    expect(verifierLoop?.recommendation).toBe("not_recommended");
    expect(baseline?.recommendation).toBe("recommended");
    expect(report.singleAgentBaseline?.recommendedCandidateIds).toEqual(["single-agent-baseline"]);
  });

  it("blocks multi-agent recommendations when the single-agent baseline is underpowered", () => {
    const benchmarkWithThreeTrialFloor: BenchmarkSpec = {
      ...singleAgentBaselineBenchmark(),
      minTrials: 3,
      trials: {
        count: 3,
        pairing: "paired",
      },
      validity: {
        minimumTrialsForRecommendation: 3,
      },
    };
    const report = createBenchmarkReport({
      benchmark: benchmarkWithThreeTrialFloor,
      mission,
      generatedAt: "2026-05-03T00:00:00.000Z",
      results: [
        baselineTrial("single-agent-baseline", 0.8, 1, 100, 0),
        ...Array.from({ length: 3 }, (_, index) => ({
          ...baselineTrial("verifier-loop", 0.95, 1.8, 140, 2),
          trialId: `verifier-loop:trial-${index + 1}`,
        })),
      ],
    });
    const verifierLoop = report.candidates.find(
      (candidate) => candidate.candidateId === "verifier-loop",
    );

    expect(verifierLoop?.singleAgentBaselineComparison?.outcome).toBe("insufficient_evidence");
    expect(verifierLoop?.recommendation).toBe("insufficient_evidence");
    expect(report.insufficientEvidence.join("\n")).toContain("baseline evidence is insufficient");
  });

  it("treats missing primary metric samples as insufficient evidence", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        {
          ...trialResult("verifier-loop", "harness.verifier-loop:compiled", "other_metric", 1),
          metrics: [],
        },
      ],
    });

    expect(report.candidates[0]?.recommendation).toBe("insufficient_evidence");
    expect(report.insufficientEvidence[0]).toContain("task_success average: missing");
  });

  it("requires primary metric samples to satisfy the recommendation threshold", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        candidates: [
          {
            id: "partial",
            harnessRef: "harness.partial",
          },
          {
            id: "complete",
            harnessRef: "harness.complete",
          },
        ],
        validity: {
          minimumTrialsForRecommendation: 3,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        trialResult("partial", "harness.partial:compiled", "task_success", 1),
        {
          ...trialResult("partial", "harness.partial:compiled", "task_success", 1),
          trialId: "partial:trial-2",
          metrics: [],
        },
        {
          ...trialResult("partial", "harness.partial:compiled", "task_success", 1),
          trialId: "partial:trial-3",
          metrics: [],
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          ...trialResult("complete", "harness.complete:compiled", "task_success", 0.8),
          trialId: `complete:trial-${index + 1}`,
        })),
      ],
    });

    expect(
      report.candidates.find((candidate) => candidate.candidateId === "partial")?.recommendation,
    ).toBe("insufficient_evidence");
    expect(
      report.candidates.find((candidate) => candidate.candidateId === "complete")?.recommendation,
    ).toBe("recommended");
    expect(report.insufficientEvidence[0]).toContain("task_success samples: 1/3");
  });

  it("limits single-run recommendations to explicit single-run benchmarks", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        trials: {
          count: 5,
          pairing: "paired",
        },
        validity: {
          minimumTrialsForRecommendation: 5,
          allowSingleRunRecommendation: true,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1),
        {
          ...trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1),
          trialId: "trial-2",
        },
      ],
    });

    expect(report.candidates[0]?.recommendation).toBe("insufficient_evidence");
  });

  it("excludes insufficient candidates from the best-metric recommendation baseline", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        candidates: [
          {
            id: "outlier",
            harnessRef: "harness.outlier",
          },
          {
            id: "steady",
            harnessRef: "harness.steady",
          },
        ],
        validity: {
          minimumTrialsForRecommendation: 5,
        },
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        trialResult("outlier", "harness.outlier:compiled", "task_success", 1),
        ...Array.from({ length: 5 }, (_, index) => ({
          ...trialResult("steady", "harness.steady:compiled", "task_success", 0.8),
          trialId: `steady:trial-${index + 1}`,
        })),
      ],
    });

    expect(
      report.candidates.find((candidate) => candidate.candidateId === "outlier")?.recommendation,
    ).toBe("insufficient_evidence");
    expect(
      report.candidates.find((candidate) => candidate.candidateId === "steady")?.recommendation,
    ).toBe("recommended");
  });

  it("summarizes repeated-run reliability without hiding failed attempts", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        candidates: [
          {
            id: "bursty",
            harnessRef: "harness.bursty",
          },
          {
            id: "steady",
            harnessRef: "harness.steady",
          },
        ],
        trials: {
          count: 4,
          pairing: "paired",
          seed: "reliability-fixture",
        },
        reliability: {
          id: "repeated-run-v0",
          successMetric: "task_success",
          successThreshold: 0.5,
          minimumScoredTrials: 4,
          passAt: [1, 2, 4],
          perturbationLabels: ["clean", "retry", "network-noise", "tool-timeout"],
        },
        validity: {
          minimumTrialsForRecommendation: 4,
        },
      },
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results: [
        reliabilityTrial("bursty", "bursty:trial-1", 1, "passed", "clean"),
        reliabilityTrial("bursty", "bursty:trial-2", 1, "passed", "retry", {
          attempt: 2,
          retryOfTrialId: "bursty:trial-1",
        }),
        reliabilityTrial("bursty", "bursty:trial-3", 0, "failed", "network-noise", {
          failureSeverity: "high",
        }),
        reliabilityTrial("bursty", "bursty:trial-4", 0, "failed", "tool-timeout", {
          failureSeverity: "critical",
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          reliabilityTrial("steady", `steady:trial-${index + 1}`, 0.5, "passed", "clean"),
        ),
      ],
    });

    const bursty = report.candidates.find((candidate) => candidate.candidateId === "bursty");
    const steady = report.candidates.find((candidate) => candidate.candidateId === "steady");

    expect(bursty?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(0.5);
    expect(steady?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(0.5);
    expect(bursty?.reliability?.passRate).toBe(0.5);
    expect(bursty?.reliability?.consistency).toBe(0.5);
    expect(bursty?.reliability?.variance).toBe(0.25);
    expect(bursty?.reliability?.retriedTrials).toBe(1);
    expect(bursty?.reliability?.maxFailureSeverity).toBe("critical");
    expect(steady?.reliability?.passRate).toBe(1);
    expect(steady?.reliability?.consistency).toBe(1);
    expect(report.recommendations[0]).toContain("reliability pass_rate=0.5");
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Reliability");
  });

  it("keeps skipped and excluded reliability trials visible", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        reliability: {
          successMetric: "task_success",
          minimumScoredTrials: 3,
        },
        validity: {
          minimumTrialsForRecommendation: 3,
        },
      },
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results: [
        reliabilityTrial("verifier-loop", "trial-1", 1, "passed", "clean"),
        reliabilityTrial("verifier-loop", "trial-2", 1, "skipped", "clean"),
        reliabilityTrial("verifier-loop", "trial-3", 1, "excluded", "clean", {
          exclusionReason: "fixture setup failed before model execution",
        }),
      ],
    });

    expect(report.candidates[0]?.reliability?.scoredTrials).toBe(1);
    expect(report.candidates[0]?.reliability?.skippedTrials).toBe(1);
    expect(report.candidates[0]?.reliability?.excludedTrials).toBe(1);
    expect(report.inferences).toContain(
      "verifier-loop: Only 1/3 scored trials; reliability recommendation remains underpowered.",
    );
    expect(renderBenchmarkReportMarkdown(report)).toContain("1 skipped trial(s) remain visible.");
  });

  it("separates final correctness from tool-use discipline", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        candidates: [
          {
            id: "disciplined",
            harnessRef: "harness.disciplined",
          },
          {
            id: "tool-happy",
            harnessRef: "harness.tool-happy",
          },
        ],
        validity: {
          minimumTrialsForRecommendation: 1,
        },
        guardrailMetrics: ["tool_efficiency"],
        toolUse: {
          id: "tool-overuse-v0",
          maxToolCalls: 2,
          cases: [
            {
              id: "requires-file-read",
              taskRef: "task.requires-context",
              expectation: "required",
              expectedToolCalls: 1,
              maxToolCalls: 1,
            },
            {
              id: "optional-lookup",
              taskRef: "task.optional-context",
              expectation: "optional",
              expectedToolCalls: 0,
              maxToolCalls: 1,
              directAnswerEligible: true,
            },
            {
              id: "wasteful-arithmetic",
              taskRef: "task.direct-answer",
              expectation: "wasteful",
              maxToolCalls: 0,
              directAnswerEligible: true,
            },
          ],
        },
      },
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results: [
        {
          ...trialResult("disciplined", "harness.disciplined:compiled", "task_success", 1),
          metrics: [
            {
              metricId: "task_success",
              value: 1,
              evidenceRefs: ["disciplined:answer"],
            },
            {
              metricId: "tool_efficiency",
              value: 1,
              evidenceRefs: ["disciplined:tool-use"],
            },
          ],
          toolUse: [
            {
              caseRef: "requires-file-read",
              toolCalls: 1,
              necessaryToolCalls: 1,
              evidenceRefs: ["trace.read-file"],
            },
            {
              caseRef: "optional-lookup",
              toolCalls: 0,
              avoidedToolCalls: 1,
              directAnswerEligible: true,
              evidenceRefs: ["trace.direct-answer"],
            },
            {
              caseRef: "wasteful-arithmetic",
              toolCalls: 0,
              avoidedToolCalls: 1,
              evidenceRefs: ["trace.no-calculator"],
            },
          ],
        },
        {
          ...trialResult("tool-happy", "harness.tool-happy:compiled", "task_success", 1),
          metrics: [
            {
              metricId: "task_success",
              value: 1,
              evidenceRefs: ["tool-happy:answer"],
            },
            {
              metricId: "tool_efficiency",
              value: 0.25,
              evidenceRefs: ["tool-happy:tool-use"],
            },
          ],
          toolUse: [
            {
              caseRef: "requires-file-read",
              toolCalls: 1,
              necessaryToolCalls: 1,
              costUsd: 0.001,
              latencyMs: 100,
              evidenceRefs: ["trace.read-file"],
            },
            {
              caseRef: "optional-lookup",
              toolCalls: 1,
              unnecessaryToolCalls: 1,
              directAnswerEligible: true,
              costUsd: 0.002,
              latencyMs: 200,
              evidenceRefs: ["trace.optional-search"],
            },
            {
              caseRef: "wasteful-arithmetic",
              toolCalls: 2,
              unnecessaryToolCalls: 2,
              budgetViolated: true,
              costUsd: 0.003,
              latencyMs: 300,
              evidenceRefs: ["trace.calculator"],
            },
          ],
        },
      ],
    });

    const disciplined = report.candidates.find(
      (candidate) => candidate.candidateId === "disciplined",
    );
    const toolHappy = report.candidates.find((candidate) => candidate.candidateId === "tool-happy");
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(disciplined?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      1,
    );
    expect(toolHappy?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      1,
    );
    expect(disciplined?.recommendation).toBe("recommended");
    expect(toolHappy?.recommendation).toBe("recommended");
    expect(disciplined?.toolUse?.efficiencyScore).toBe(1);
    expect(disciplined?.toolUse?.avoidedToolCalls).toBe(2);
    expect(toolHappy?.toolUse?.efficiencyScore).toBe(0.25);
    expect(toolHappy?.toolUse?.unnecessaryToolCalls).toBe(3);
    expect(toolHappy?.toolUse?.budgetViolations).toBe(1);
    expect(toolHappy?.toolUse?.totalCostUsd).toBeCloseTo(0.006);
    expect(toolHappy?.toolUse?.totalLatencyMs).toBe(600);
    expect(disciplined?.toolUse?.observedCaseCount).toBe(3);
    expect(toolHappy?.toolUse?.observedCaseCount).toBe(3);
    expect(report.toolUse?.observedCaseCount).toBe(3);
    expect(report.toolUse?.byExpectation.map((entry) => entry.observedCaseCount)).toEqual([
      1, 1, 1,
    ]);
    expect(report.recommendations[1]).toContain("tool_efficiency=0.25");
    expect(report.inferences).toContain(
      "Tool-use efficiency is reported separately from final task correctness.",
    );
    expect(markdown).toContain("## Tool Use");
  });

  it("normalizes repeated and internally inconsistent tool-use observations", () => {
    const repeatedCase = "requires-file-read";
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        candidates: [{ id: "inconsistent", harnessRef: "harness.inconsistent" }],
        validity: {
          minimumTrialsForRecommendation: 1,
        },
        toolUse: {
          id: "tool-overuse-edge-v0",
          cases: [
            {
              id: repeatedCase,
              taskRef: "task.requires-context",
              expectation: "required",
              expectedToolCalls: 1,
              maxToolCalls: 2,
            },
          ],
        },
      },
      mission,
      generatedAt: "2026-04-30T00:00:00.000Z",
      results: [
        {
          ...trialResult("inconsistent", "harness.inconsistent:compiled", "task_success", 1),
          trialId: "inconsistent:trial-1",
          toolUse: [
            {
              caseRef: repeatedCase,
              toolCalls: 2,
              necessaryToolCalls: 5,
              unnecessaryToolCalls: 5,
              evidenceRefs: ["trace.inconsistent.overreported-counts"],
            },
          ],
        },
        {
          ...trialResult("inconsistent", "harness.inconsistent:compiled", "task_success", 1),
          trialId: "inconsistent:trial-2",
          toolUse: [
            {
              caseRef: repeatedCase,
              toolCalls: 2,
              unnecessaryToolCalls: 5,
              evidenceRefs: ["trace.inconsistent.repeated-case"],
            },
          ],
        },
      ],
    });

    const candidate = report.candidates.find(
      (entry) => entry.candidateId === "inconsistent",
    );

    expect(candidate?.toolUse?.observedCaseCount).toBe(1);
    expect(candidate?.toolUse?.plannedCaseCount).toBe(1);
    expect(candidate?.toolUse?.totalToolCalls).toBe(4);
    expect(candidate?.toolUse?.necessaryToolCalls).toBe(3);
    expect(candidate?.toolUse?.unnecessaryToolCalls).toBe(1);
    expect(candidate?.toolUse?.efficiencyScore).toBe(0.75);
    expect(report.toolUse?.observedCaseCount).toBe(1);
    expect(report.toolUse?.byExpectation[0]).toMatchObject({
      expectation: "required",
      plannedCaseCount: 1,
      observedCaseCount: 1,
      toolCalls: 4,
      unnecessaryToolCalls: 1,
    });
  });

  it("aggregates fault-injection containment evidence into reports", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
        faultInjections: [
          {
            id: "memory-stale-context",
            boundary: "memory",
            perturbation: "stale_context",
            targetRef: "memory.user-profile",
            expectedBehavior: "mark_insufficient_evidence",
            firstViolatedContract: "memory.provenance",
          },
        ],
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [
        {
          ...trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1),
          faultInjections: [
            {
              specRef: "memory-stale-context",
              boundary: "memory",
              perturbation: "stale_context",
              contained: true,
              recovered: true,
              overclaimPrevented: true,
              firstViolatedContract: "memory.provenance",
              recoveryPath: ["detected-stale-fact", "asked-for-verification"],
              evidenceRefs: ["trace-1", "artifact-1"],
            },
          ],
        },
      ],
    });

    expect(report.faultInjection?.plannedCaseCount).toBe(1);
    expect(report.faultInjection?.observedCaseCount).toBe(1);
    expect(report.faultInjection?.containmentRate).toBe(1);
    expect(report.candidates[0]?.faultInjection?.overclaimPreventionRate).toBe(1);
    expect(report.faultInjection?.firstViolatedContracts).toEqual(["memory.provenance"]);
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Fault Injection");
  });

  it("records a fault-injection evidence gap when configured cases have no observations", () => {
    const report = createBenchmarkReport({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
        faultInjections: [
          {
            id: "tool-timeout",
            boundary: "tool",
            perturbation: "timeout",
            targetRef: "tool.shell",
            expectedBehavior: "fallback",
          },
        ],
      },
      mission,
      generatedAt: "2026-04-25T00:00:00.000Z",
      results: [trialResult("verifier-loop", "harness.verifier-loop:compiled", "task_success", 1)],
    });

    expect(report.faultInjection?.plannedCaseCount).toBe(1);
    expect(report.faultInjection?.observedCaseCount).toBe(0);
    expect(report.insufficientEvidence).toContain(
      "Fault injections were configured but no trial observations recorded their outcomes.",
    );
  });
});

function singleAgentBaselineBenchmark(): BenchmarkSpec {
  return {
    ...benchmark,
    candidates: [
      {
        id: "single-agent-baseline",
        harnessRef: "harness.single-agent-baseline",
        kind: "single_agent_baseline",
      },
      {
        id: "verifier-loop",
        harnessRef: "harness.verifier-loop",
      },
      {
        id: "hierarchy",
        harnessRef: "harness.hierarchy",
      },
    ],
    metricDefinitions: [
      {
        id: "task_success",
        name: "Task success",
        unit: "ratio",
        direction: "higher_is_better",
        source: "grader",
      },
      {
        id: "cost_usd",
        name: "Cost",
        unit: "usd",
        direction: "lower_is_better",
        source: "runtime",
      },
      {
        id: "wall_time",
        name: "Wall time",
        unit: "seconds",
        direction: "lower_is_better",
        source: "runtime",
      },
      {
        id: "handoff_count",
        name: "Handoff count",
        unit: "count",
        direction: "lower_is_better",
        source: "trace",
      },
    ],
    guardrailMetrics: ["cost_usd", "wall_time", "handoff_count"],
    singleAgentBaseline: {
      minimumDelta: 0.05,
    },
    minTrials: 1,
    trials: {
      count: 1,
      pairing: "paired",
    },
    validity: {
      minimumTrialsForRecommendation: 1,
    },
  };
}

function baselineTrial(
  candidateId: string,
  taskSuccess: number,
  costUsd: number,
  wallTime: number,
  handoffCount: number,
): BenchmarkTrialResult {
  return {
    ...trialResult(candidateId, `harness.${candidateId}:compiled`, "task_success", taskSuccess),
    metrics: [
      {
        metricId: "task_success",
        value: taskSuccess,
        evidenceRefs: [`${candidateId}:task-success`],
      },
      {
        metricId: "cost_usd",
        value: costUsd,
        evidenceRefs: [`${candidateId}:cost`],
      },
      {
        metricId: "wall_time",
        value: wallTime,
        evidenceRefs: [`${candidateId}:wall-time`],
      },
      {
        metricId: "handoff_count",
        value: handoffCount,
        evidenceRefs: [`${candidateId}:handoffs`],
      },
    ],
  };
}

function trialResult(
  candidateId: string,
  harnessId: string,
  metricId: string,
  value: number,
): BenchmarkTrialResult {
  return {
    candidateId,
    harnessId,
    trialId: `${candidateId}:trial-1`,
    metrics: [
      {
        metricId,
        value,
        evidenceRefs: [`${candidateId}:artifact-1`],
      },
    ],
    traceEvents: [],
    artifacts: [],
    diagnostics: {
      completeness: 1,
      missingRequiredEventTypes: [],
      handoffCount: 0,
      reworkCount: 0,
      policyDecisionCount: 0,
      artifactCount: 0,
    },
  };
}

function reliabilityTrial(
  candidateId: string,
  trialId: string,
  taskSuccess: number,
  status: NonNullable<BenchmarkTrialResult["outcome"]>["status"],
  perturbationLabel: string,
  outcome?: Partial<NonNullable<BenchmarkTrialResult["outcome"]>>,
): BenchmarkTrialResult {
  return {
    ...trialResult(candidateId, `harness.${candidateId}:compiled`, "task_success", taskSuccess),
    trialId,
    outcome: {
      status,
      perturbationLabel,
      ...outcome,
    },
  };
}
