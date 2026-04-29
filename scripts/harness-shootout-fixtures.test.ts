import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileHarnessDsl,
  createBenchmarkReport,
  renderBenchmarkReportMarkdown,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type HarnessDsl,
  type MissionSpec,
} from "../packages/sdk/src/harness/index.js";

const repoRoot = resolve(import.meta.dirname, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
}

describe("harness shootout fixtures", () => {
  it("keeps package-composed candidate harnesses compilable", () => {
    const candidatePaths = [
      "examples/harness-shootout/candidates/pipeline.json",
      "examples/harness-shootout/candidates/verifier-loop.json",
      "examples/harness-shootout/candidates/hierarchy.json",
      "examples/harness-shootout/candidates/squad.json",
    ];

    for (const path of candidatePaths) {
      const result = compileHarnessDsl(readJson<HarnessDsl>(path));

      expect(result.diagnostics).toEqual([]);
      expect(result.compiled?.id).toBeDefined();
    }
  });

  it("distinguishes average score from repeated-run reliability", () => {
    const benchmark = readJson<BenchmarkSpec>(
      "examples/harness-shootout/reliability/benchmark.json",
    );
    const mission = readJson<MissionSpec>("examples/harness-shootout/mission.json");
    const results = readJson<BenchmarkTrialResult[]>(
      "examples/harness-shootout/reliability/trial-results.json",
    );
    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results,
    });
    const bursty = report.candidates.find(
      (candidate) => candidate.candidateId === "pipeline-bursty",
    );
    const steady = report.candidates.find(
      (candidate) => candidate.candidateId === "verifier-loop-steady",
    );

    expect(bursty?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      0.5,
    );
    expect(steady?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      0.5,
    );
    expect(bursty?.reliability?.passRate).toBe(0.5);
    expect(bursty?.reliability?.maxFailureSeverity).toBe("critical");
    expect(bursty?.reliability?.retriedTrials).toBe(1);
    expect(steady?.reliability?.passRate).toBe(1);
    expect(steady?.reliability?.maxFailureSeverity).toBe("low");
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Reliability");
  });
});
