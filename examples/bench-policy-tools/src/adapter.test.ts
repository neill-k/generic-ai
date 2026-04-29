import { describe, expect, it } from "vitest";
import type { BenchmarkReportCandidate } from "@generic-ai/sdk";
import { loadPolicyToolsFixture, runPolicyToolsSmoke } from "./adapter.js";

describe("bench-policy-tools adapter", () => {
  it("loads a meso BenchmarkSpec, MissionSpec, and candidate harnesses", async () => {
    const fixture = await loadPolicyToolsFixture();

    expect(fixture.benchmark.id).toBe("benchmark.meso.policy-tools-refund.v0");
    expect(fixture.mission.id).toBe("mission.meso.policy-tools-refund");
    expect(Object.keys(fixture.harnesses)).toEqual([
      "harness.meso.direct-tool-executor",
      "harness.meso.policy-gated-tool-planner",
    ]);
  });

  it("runs the deterministic adapter through the bounded report pipeline", async () => {
    const result = await runPolicyToolsSmoke();

    expect(result.report.evidence.traceEventCount).toBeGreaterThan(0);
    expect(result.report.candidates).toHaveLength(2);
    expect(
      result.report.candidates.find(
        (candidate: BenchmarkReportCandidate) =>
          candidate.candidateId === "policy-gated-tool-planner",
      )?.scorecard,
    ).toContainEqual({
      metricId: "task_success",
      value: 1,
      evidenceRefs: expect.any(Array),
    });
    expect(result.markdown).toContain("# Benchmark Report: benchmark.meso.policy-tools-refund.v0");
  });
});
