import { describe, expect, it } from "vitest";
import type { BenchmarkReportCandidate } from "@generic-ai/sdk";
import { loadToolCallingFixture, runToolCallingSmoke } from "./adapter.js";

describe("bench-tool-calling adapter", () => {
  it("loads a micro BenchmarkSpec, MissionSpec, and candidate harnesses", async () => {
    const fixture = await loadToolCallingFixture();

    expect(fixture.benchmark.id).toBe("benchmark.micro.tool-calling-retrieval.v0");
    expect(fixture.mission.id).toBe("mission.micro.tool-calling-retrieval");
    expect(Object.keys(fixture.harnesses)).toEqual([
      "harness.micro.direct-function-caller",
      "harness.micro.retrieval-grounded-tool-caller",
    ]);
  });

  it("runs the deterministic adapter through the bounded report pipeline", async () => {
    const result = await runToolCallingSmoke();

    expect(result.report.evidence.traceEventCount).toBeGreaterThan(0);
    expect(result.report.candidates).toHaveLength(2);
    expect(
      result.report.candidates.find(
        (candidate: BenchmarkReportCandidate) =>
          candidate.candidateId === "retrieval-grounded-tool-caller",
      )?.scorecard,
    ).toContainEqual({
      metricId: "task_success",
      value: 1,
      evidenceRefs: expect.any(Array),
    });
    expect(result.markdown).toContain("# Benchmark Report: benchmark.micro.tool-calling-retrieval.v0");
  });
});
