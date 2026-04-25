import { describe, expect, it } from "vitest";
import {
  compileHarnessDsl,
  createPipelineProtocol,
  createSquadProtocol,
  createBenchmarkReport,
  HARNESS_SCHEMA_VERSION,
  renderBenchmarkReportMarkdown,
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
    const pipelineResult = await pipeline.reduce({
      compiled: compiled!,
      state: { status: "ready" },
      events: [],
    });
    const squadDiagnostics = await squad.validate?.(compiled!);
    const noSharedSpaceDiagnostics = await squad.validate?.(noSharedSpaceCompiled!);

    expect(pipelineResult.actions[0]?.kind).toBe("invoke_actor");
    expect(pipelineResult.summary.status).toBe("ready");
    expect(squadDiagnostics).toEqual([]);
    expect(noSharedSpaceDiagnostics?.[0]?.code).toBe("missing_shared_space");
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
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Recommendations");
  });
});
