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

  it("reports memory-operation quality separately from final correctness", async () => {
    const mission = await readJson<MissionSpec>("examples/harness-shootout/memory/mission.json");
    const benchmark = await readJson<BenchmarkSpec>(
      "examples/harness-shootout/memory/benchmark.json",
    );
    const candidatePaths = [
      "examples/harness-shootout/memory/candidates/memory-disciplined-agent.json",
      "examples/harness-shootout/memory/candidates/memory-shortcut-agent.json",
    ];
    const candidates = await Promise.all(candidatePaths.map((path) => readJson<HarnessDsl>(path)));
    const results = await readJson<BenchmarkTrialResult[]>(
      "examples/harness-shootout/memory/trial-results.json",
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
      generatedAt: "2026-05-01T00:00:00.000Z",
      results,
    });
    const disciplined = report.candidates.find(
      (candidate) => candidate.candidateId === "memory-disciplined-agent",
    );
    const shortcut = report.candidates.find(
      (candidate) => candidate.candidateId === "memory-shortcut-agent",
    );
    const markdown = renderBenchmarkReportMarkdown(report);

    expect(benchmark.memory?.cases).toHaveLength(6);
    expect(
      disciplined?.scorecard.find((metric) => metric.metricId === "answer_correct_rate")?.value,
    ).toBe(1);
    expect(
      shortcut?.scorecard.find((metric) => metric.metricId === "answer_correct_rate")?.value,
    ).toBe(1);
    expect(disciplined?.memory?.memoryQualityScore).toBe(1);
    expect(disciplined?.memory?.retrievalMissCount).toBe(0);
    expect(disciplined?.memory?.staleFactUseCount).toBe(0);
    expect(disciplined?.memory?.leakedForgottenRefCount).toBe(0);
    expect(disciplined?.memory?.provenanceCoverageRate).toBe(1);
    expect(disciplined?.memory?.handoffPreservedCount).toBe(1);
    expect(shortcut?.memory?.answerCorrectRate).toBe(1);
    expect(shortcut?.memory?.memoryQualityScore).toBeCloseTo(0.2083, 4);
    expect(shortcut?.memory?.retrievalMissCount).toBe(1);
    expect(shortcut?.memory?.staleFactUseCount).toBe(2);
    expect(shortcut?.memory?.leakedForgottenRefCount).toBe(1);
    expect(shortcut?.memory?.provenanceCoverageRate).toBeCloseTo(1 / 6, 6);
    expect(shortcut?.memory?.warnings).toEqual(
      expect.arrayContaining([
        "1 relevant memory ref(s) were missed.",
        "2 stale memory ref(s) were used.",
        "1 forgotten memory ref(s) leaked into output.",
        "5 memory case(s) lacked provenance evidence.",
      ]),
    );
    expect(report.memory?.observedCaseCount).toBe(6);
    expect(markdown).toContain("## Memory");
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
