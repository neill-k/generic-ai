import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileHarnessDsl,
  createBenchmarkReport,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type HarnessDsl,
  type MissionSpec,
} from "@generic-ai/sdk";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson<T>(relativePath: string): Promise<T> {
  const contents = await readFile(resolve(repoRoot, relativePath), "utf8");
  return JSON.parse(contents) as T;
}

describe("harness shootout fixtures", () => {
  it("compiles the fault-injection fixture and reports containment evidence", async () => {
    const mission = await readJson<MissionSpec>(
      "examples/harness-shootout/fault-injection/mission.json",
    );
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/fault-injection/benchmark.json",
    );
    const harness = await readJson<HarnessDsl>(
      "examples/harness-shootout/fault-injection/candidates/fault-aware-verifier.json",
    );

    const compiled = compileHarnessDsl(harness);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.compiled?.sourceId).toBe("harness.fault-aware-verifier");
    expect(benchmark.missionRef).toBe(mission.id);
    expect(benchmark.faultInjections).toHaveLength(2);

    const trial: BenchmarkTrialResult = {
      candidateId: "fault-aware-verifier",
      harnessId: "harness.fault-aware-verifier:compiled",
      trialId: "fault-aware-verifier:trial:1",
      metrics: [
        {
          metricId: "fault_containment",
          value: 1,
          evidenceRefs: ["trace.tool-timeout", "trace.stale-memory"],
        },
        {
          metricId: "fault_recovery",
          value: 1,
          evidenceRefs: ["trace.tool-timeout", "trace.stale-memory"],
        },
        {
          metricId: "overclaim_prevented",
          value: 1,
          evidenceRefs: ["artifact.fault-report"],
        },
        {
          metricId: "trace_completeness",
          value: 1,
          evidenceRefs: ["trace.tool-timeout", "trace.stale-memory"],
        },
      ],
      traceEvents: [],
      artifacts: [
        {
          id: "artifact.fault-report",
          kind: "report",
          uri: "memory:///fault-injection-report.json",
          redaction: "metadata_only",
          summary: "Fault-injection containment report.",
        },
      ],
      diagnostics: {
        completeness: 1,
        missingRequiredEventTypes: [],
        handoffCount: 0,
        reworkCount: 0,
        policyDecisionCount: 0,
        artifactCount: 1,
      },
      faultInjections: [
        {
          specRef: "tool-shell-timeout",
          boundary: "tool",
          perturbation: "timeout",
          contained: true,
          recovered: true,
          overclaimPrevented: true,
          firstViolatedContract: "tool.result.deadline",
          recoveryPath: ["deadline-detected", "fallback-recorded"],
          evidenceRefs: ["trace.tool-timeout"],
        },
        {
          specRef: "memory-profile-stale-context",
          boundary: "memory",
          perturbation: "stale_context",
          contained: true,
          recovered: true,
          overclaimPrevented: true,
          firstViolatedContract: "memory.provenance",
          recoveryPath: ["provenance-missing", "insufficient-evidence"],
          evidenceRefs: ["trace.stale-memory"],
        },
      ],
    };

    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results: [trial],
    });

    expect(report.faultInjection?.plannedCaseCount).toBe(2);
    expect(report.faultInjection?.observedCaseCount).toBe(2);
    expect(report.faultInjection?.containmentRate).toBe(1);
    expect(report.candidates[0]?.recommendation).toBe("recommended");
  });
});
