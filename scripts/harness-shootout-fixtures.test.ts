import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileHarnessDsl,
  createBenchmarkReport,
  renderBenchmarkReportMarkdown,
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
  it("keeps package-composed candidate harnesses compilable", async () => {
    const candidatePaths = [
      "examples/harness-shootout/candidates/pipeline.json",
      "examples/harness-shootout/candidates/verifier-loop.json",
      "examples/harness-shootout/candidates/hierarchy.json",
      "examples/harness-shootout/candidates/squad.json",
    ];

    for (const path of candidatePaths) {
      const result = compileHarnessDsl(await readJson<HarnessDsl>(path));

      expect(result.diagnostics).toEqual([]);
      expect(result.compiled?.id).toBeDefined();
    }
  });

  it("distinguishes average score from repeated-run reliability", async () => {
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/reliability/benchmark.json",
    );
    const mission = await readJson<MissionSpec>("examples/harness-shootout/mission.json");
    const results = await readJson<BenchmarkTrialResult[]>(
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

    expect(bursty?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(0.5);
    expect(steady?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(0.5);
    expect(bursty?.reliability?.passRate).toBe(0.5);
    expect(bursty?.reliability?.maxFailureSeverity).toBe("critical");
    expect(bursty?.reliability?.retriedTrials).toBe(1);
    expect(steady?.reliability?.passRate).toBe(1);
    expect(steady?.reliability?.maxFailureSeverity).toBe("low");
    expect(renderBenchmarkReportMarkdown(report)).toContain("## Reliability");
  });

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

  it("reports tool-use discipline separately from final correctness", async () => {
    const mission = await readJson<MissionSpec>(
      "examples/harness-shootout/tool-overuse/mission.json",
    );
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/tool-overuse/benchmark.json",
    );
    const results = await readJson<BenchmarkTrialResult[]>(
      "examples/harness-shootout/tool-overuse/trial-results.json",
    );

    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-29T00:00:00.000Z",
      results,
    });
    const disciplined = report.candidates.find(
      (candidate) => candidate.candidateId === "disciplined-agent",
    );
    const toolHappy = report.candidates.find(
      (candidate) => candidate.candidateId === "tool-happy-agent",
    );
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(benchmark.toolUse?.cases.map((entry) => entry.expectation)).toEqual([
      "required",
      "optional",
      "wasteful",
    ]);
    expect(disciplined?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      1,
    );
    expect(toolHappy?.scorecard.find((metric) => metric.metricId === "task_success")?.value).toBe(
      1,
    );
    expect(disciplined?.toolUse?.efficiencyScore).toBe(1);
    expect(disciplined?.toolUse?.observedCaseCount).toBe(3);
    expect(disciplined?.toolUse?.avoidedToolCalls).toBe(2);
    expect(toolHappy?.toolUse?.efficiencyScore).toBe(0.25);
    expect(toolHappy?.toolUse?.observedCaseCount).toBe(3);
    expect(toolHappy?.toolUse?.unnecessaryToolCalls).toBe(3);
    expect(toolHappy?.toolUse?.budgetViolations).toBe(1);
    expect(toolHappy?.toolUse?.totalLatencyMs).toBe(600);
    expect(report.toolUse?.observedCaseCount).toBe(3);
    expect(markdown).toContain("## Tool Use");
  });

  it("reports contextual-integrity privacy separately from task utility", async () => {
    const mission = await readJson<MissionSpec>(
      "examples/harness-shootout/contextual-integrity/mission.json",
    );
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/contextual-integrity/benchmark.json",
    );
    const candidatePaths = [
      "examples/harness-shootout/contextual-integrity/candidates/privacy-aware-agent.json",
      "examples/harness-shootout/contextual-integrity/candidates/oversharing-agent.json",
    ];
    const candidates = await Promise.all(candidatePaths.map((path) => readJson<HarnessDsl>(path)));
    const results = await readJson<BenchmarkTrialResult[]>(
      "examples/harness-shootout/contextual-integrity/trial-results.json",
    );

    for (const candidate of candidates) {
      const compiled = compileHarnessDsl(candidate);
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.compiled?.missionRefs).toContain(mission.id);
      expect(compiled.compiled?.evalRefs).toContain(benchmark.id);
    }

    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-04-30T00:00:00.000Z",
      results,
    });
    const privacyAware = report.candidates.find(
      (candidate) => candidate.candidateId === "privacy-aware-agent",
    );
    const oversharing = report.candidates.find(
      (candidate) => candidate.candidateId === "oversharing-agent",
    );
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(
      privacyAware?.scorecard.find((metric) => metric.metricId === "task_utility")?.value,
    ).toBe(1);
    expect(oversharing?.scorecard.find((metric) => metric.metricId === "task_utility")?.value).toBe(
      1,
    );
    expect(privacyAware?.contextualIntegrity?.contextualIntegrityScore).toBe(1);
    expect(privacyAware?.contextualIntegrity?.leakageRate).toBe(0);
    expect(oversharing?.contextualIntegrity?.contextualIntegrityScore).toBe(0.5);
    expect(oversharing?.contextualIntegrity?.leakageRate).toBe(1);
    expect(oversharing?.contextualIntegrity?.prohibitedDisclosureViolationCount).toBe(3);
    expect(report.contextualIntegrity?.observedCaseCount).toBe(2);
    expect(markdown).toContain("## Contextual Integrity");
  });

  it("reports Chinese web research evidence separately from answer correctness", async () => {
    const mission = await readJson<MissionSpec>(
      "examples/harness-shootout/chinese-web-research/mission.json",
    );
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/chinese-web-research/benchmark.json",
    );
    const candidatePaths = [
      "examples/harness-shootout/chinese-web-research/candidates/source-aware-researcher.json",
      "examples/harness-shootout/chinese-web-research/candidates/citation-naive-researcher.json",
    ];
    const candidates = await Promise.all(candidatePaths.map((path) => readJson<HarnessDsl>(path)));
    const results = await readJson<BenchmarkTrialResult[]>(
      "examples/harness-shootout/chinese-web-research/trial-results.json",
    );

    for (const candidate of candidates) {
      const compiled = compileHarnessDsl(candidate);
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.compiled?.missionRefs).toContain(mission.id);
      expect(compiled.compiled?.evalRefs).toContain(benchmark.id);
    }

    const report = createBenchmarkReport({
      benchmark,
      mission,
      generatedAt: "2026-05-02T00:00:00.000Z",
      results,
    });
    const sourceAware = report.candidates.find(
      (candidate) => candidate.candidateId === "source-aware-researcher",
    );
    const citationNaive = report.candidates.find(
      (candidate) => candidate.candidateId === "citation-naive-researcher",
    );
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(benchmark.webResearch?.locale).toBe("zh-CN");
    expect(benchmark.webResearch?.liveSearch?.providerAgnostic).toBe(true);
    expect(benchmark.webResearch?.liveSearch?.enabledByDefault).toBe(false);
    expect(benchmark.webResearch?.sources.map((source) => source.title)).toContain(
      "地方教育数字化行动方案发布",
    );
    expect(
      sourceAware?.scorecard.find((metric) => metric.metricId === "answer_correctness")?.value,
    ).toBe(1);
    expect(
      citationNaive?.scorecard.find((metric) => metric.metricId === "answer_correctness")?.value,
    ).toBe(0.5);
    expect(sourceAware?.webResearch?.answerCorrectRate).toBe(1);
    expect(sourceAware?.webResearch?.citationCoverageRate).toBe(1);
    expect(sourceAware?.webResearch?.reconciliationRate).toBe(1);
    expect(sourceAware?.webResearch?.staleSourceUseCount).toBe(0);
    expect(sourceAware?.webResearch?.chineseTextPreservationRate).toBe(1);
    expect(citationNaive?.webResearch?.answerCorrectRate).toBe(0.5);
    expect(citationNaive?.webResearch?.citationCoverageRate).toBe(0);
    expect(citationNaive?.webResearch?.reconciliationRate).toBe(0);
    expect(citationNaive?.webResearch?.staleSourceUseCount).toBe(1);
    expect(citationNaive?.webResearch?.chineseTextPreservationRate).toBe(0.5);
    expect(report.webResearch?.observedCaseCount).toBe(2);
    expect(markdown).toContain("## Web Research");
    expect(markdown).toContain("Chinese text preserved");

    if (benchmark.webResearch === undefined) {
      throw new Error("Expected Chinese web-research fixture to define a webResearch profile.");
    }
    const sourceAwareResult = results.find(
      (result) => result.candidateId === "source-aware-researcher",
    );
    if (sourceAwareResult === undefined) {
      throw new Error("Expected Chinese web-research fixture to include source-aware results.");
    }

    const edgeBenchmark: BenchmarkSpec = {
      ...benchmark,
      candidates: [{ id: "edge-web-researcher", harnessRef: "harness.edge-web-researcher" }],
      webResearch: {
        ...benchmark.webResearch,
        cases: [
          {
            id: "optional-background-check",
            taskRef: "task.optional-background-check",
            queryLanguage: "zh-CN",
            answerUniqueness: "open-ended",
            citationRequired: false,
            requiresCrossSourceReconciliation: false,
          },
          {
            id: "empty-required-reconciliation",
            taskRef: "task.empty-required-reconciliation",
            queryLanguage: "zh-CN",
            answerUniqueness: "ambiguous",
            requiredSourceRefs: [],
            citationRequired: true,
            requiresCrossSourceReconciliation: true,
          },
        ],
      },
    };
    const edgeReport = createBenchmarkReport({
      benchmark: edgeBenchmark,
      mission,
      generatedAt: "2026-05-02T00:00:00.000Z",
      results: [
        {
          ...sourceAwareResult,
          candidateId: "edge-web-researcher",
          harnessId: "harness.edge-web-researcher:compiled",
          trialId: "edge-web-researcher:trial-1",
          webResearch: [
            {
              caseRef: "optional-background-check",
              answerCorrect: true,
              citedSourceRefs: [],
              chineseTextPreserved: true,
              evidenceRefs: ["trace.edge.optional"],
            },
            {
              caseRef: "empty-required-reconciliation",
              answerCorrect: true,
              citedSourceRefs: [],
              reconciledSourceRefs: [],
              chineseTextPreserved: true,
              evidenceRefs: ["trace.edge.empty-required"],
            },
          ],
        },
      ],
    });
    const edgeCandidate = edgeReport.candidates.find(
      (candidate) => candidate.candidateId === "edge-web-researcher",
    );
    const emptyRequiredCase = edgeCandidate?.webResearch?.byCase.find(
      (caseSummary) => caseSummary.caseRef === "empty-required-reconciliation",
    );

    expect(edgeCandidate?.webResearch?.citationRequiredCount).toBe(1);
    expect(edgeCandidate?.webResearch?.citationCoverageCount).toBe(0);
    expect(edgeCandidate?.webResearch?.citationCoverageRate).toBe(0);
    expect(emptyRequiredCase?.requiredSourceCoverage).toBe(1);
    expect(edgeCandidate?.webResearch?.reconciliationRequiredCount).toBe(1);
    expect(edgeCandidate?.webResearch?.reconciliationSatisfiedCount).toBe(0);
    expect(edgeCandidate?.webResearch?.reconciliationRate).toBe(0);
    expect(edgeCandidate?.webResearch?.warnings).toContain(
      "Cross-source reconciliation is required with fewer than two required sources for empty-required-reconciliation.",
    );
  });

  it("compiles the DAG navigation candidate harnesses", async () => {
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/dag-navigation/benchmark.json",
    );
    const candidatePaths = [
      "examples/harness-shootout/dag-navigation/candidates/linear-chain.json",
      "examples/harness-shootout/dag-navigation/candidates/dag-aware-planner.json",
      "examples/harness-shootout/dag-navigation/candidates/squad-branch-workers.json",
    ];
    const candidates = await Promise.all(candidatePaths.map((path) => readJson<HarnessDsl>(path)));

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
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/dag-navigation/benchmark.json",
    );
    const mission = await readJson<MissionSpec>(
      "examples/harness-shootout/dag-navigation/mission.json",
    );
    const failureExamples = await readJson<{
      readonly cases: readonly {
        readonly id: string;
        readonly diagnosis: string;
        readonly trialResult: BenchmarkTrialResult;
      }[];
    }>("examples/harness-shootout/dag-navigation/failure-examples.json");

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
