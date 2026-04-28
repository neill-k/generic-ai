import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileHarnessDsl,
  createBenchmarkReport,
  renderBenchmarkReportMarkdown,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type HarnessDsl,
  type MissionSpec,
} from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagProfileRoot = resolve(repoRoot, "examples/harness-shootout/dag-navigation");

async function readJson<T>(...segments: readonly string[]): Promise<T> {
  const text = await readFile(resolve(dagProfileRoot, ...segments), "utf8");
  return JSON.parse(text) as T;
}

describe("harness-shootout DAG navigation profile", () => {
  it("compiles the DAG navigation candidate harnesses", async () => {
    const benchmark = await readJson<BenchmarkSpec>("benchmark.json");
    const candidateFiles = [
      "candidates/linear-chain.json",
      "candidates/dag-aware-planner.json",
      "candidates/squad-branch-workers.json",
    ];
    const candidates = await Promise.all(candidateFiles.map((path) => readJson<HarnessDsl>(path)));

    expect(benchmark.id).toBe("benchmark.dag-navigation.v0");
    expect(benchmark.candidates.map((candidate) => candidate.id)).toEqual([
      "linear-chain",
      "dag-aware-planner",
      "squad-branch-workers",
    ]);
    expect(benchmark.guardrailMetrics).toEqual(
      expect.arrayContaining([
        "navigation_progress",
        "branch_visit_completeness",
        "tool_correctness",
        "aggregation_correctness",
      ]),
    );

    for (const candidate of candidates) {
      const result = compileHarnessDsl(candidate);
      expect(result.diagnostics).toEqual([]);
      expect(result.compiled?.missionRefs).toContain("mission.dag-navigation");
      expect(result.compiled?.evalRefs).toContain("benchmark.dag-navigation.v0");
    }
  });

  it("renders separate navigation and tool-output failure evidence", async () => {
    const benchmark = await readJson<BenchmarkSpec>("benchmark.json");
    const mission = await readJson<MissionSpec>("mission.json");
    const failureExamples = await readJson<{
      readonly cases: readonly {
        readonly id: string;
        readonly diagnosis: string;
        readonly trialResult: BenchmarkTrialResult;
      }[];
    }>("failure-examples.json");

    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-28T00:00:00.000Z",
      results: failureExamples.cases.map((entry) => entry.trialResult),
    });
    const markdown = renderBenchmarkReportMarkdown(report);
    const wrongBranch = report.candidates.find(
      (candidate) => candidate.candidateId === "linear-chain",
    );
    const badTool = report.candidates.find(
      (candidate) => candidate.candidateId === "dag-aware-planner",
    );

    expect(failureExamples.cases.map((entry) => entry.diagnosis)).toEqual([
      "navigation_error",
      "tool_output_error",
    ]);
    expect(
      wrongBranch?.scorecard.find((metric) => metric.metricId === "tool_correctness")?.value,
    ).toBe(1);
    expect(
      wrongBranch?.scorecard.find((metric) => metric.metricId === "branch_visit_completeness")
        ?.value,
    ).toBe(0.5);
    expect(
      badTool?.scorecard.find((metric) => metric.metricId === "navigation_progress")?.value,
    ).toBe(1);
    expect(badTool?.scorecard.find((metric) => metric.metricId === "tool_correctness")?.value).toBe(
      0.5,
    );
    expect(markdown).toContain("## Candidates");
    expect(report.insufficientEvidence).toHaveLength(3);
  });
});
