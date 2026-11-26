import { describe, expect, it } from "vitest";

import type { RunRecord, RunStoreContract } from "../../src/contracts/run-store.js";
import type { JsonObject } from "../../src/contracts/shared.js";
import {
  estimatePassHatK,
  GOAL_EVAL_DERIVED_METRICS,
  type GoalEvalCaseSpec,
  type GoalEvalSuiteSpec,
  type GoalEvalTrialRecord,
  goalEvalRecordFromRunStore,
  parseGoalEvalSuite,
  renderGoalEvalMarkdown,
  runGoalEvalSuite,
  scoreGoalEvalTrial,
  sealGoalEvalCase,
  summarizeGoalEval,
} from "../../src/evals/index.js";
import { type CanonicalEvent, createCanonicalEvent } from "../../src/events/index.js";
import type { GoalJudge } from "../../src/goals/index.js";
import type { ModelUsage } from "../../src/usage/index.js";

const fixedNow = () => new Date("2026-11-26T12:00:00.000Z");

const context = (runId: string) => ({
  scopeId: "scope/root",
  runId,
  rootSessionId: `${runId}:root`,
  sessionId: `${runId}:root`,
});

function usage(input: number, output: number, costUsd = 0): ModelUsage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: costUsd / 2, output: costUsd / 2, cacheRead: 0, cacheWrite: 0, total: costUsd },
  };
}

function tool(
  runId: string,
  toolName: string,
  args: JsonObject,
  roleId = "analyst",
): CanonicalEvent {
  return createCanonicalEvent({
    ...context(runId),
    name: "tool.call.completed",
    data: { toolName, args, roleId },
  });
}

function spend(runId: string, tokens: number, costUsd: number): CanonicalEvent {
  return createCanonicalEvent({
    ...context(runId),
    name: "usage.recorded",
    data: { provider: "anthropic", model: "claude-opus-5-5", usage: usage(tokens, 0, costUsd) },
  });
}

/**
 * NVDA example from the NOVA paper's goal section: a numeric rating, a rubric
 * on the write-up, and required data-gathering actions in the trace.
 */
const nvdaCase: GoalEvalCaseSpec = {
  id: "nvda-rating",
  title: "NVDA buy/sell rating",
  instruction: "Use the research CLI to gather data before rating.",
  goal: {
    id: "nvda-rating",
    objective: "Provide a buy/sell rating for NVDA between 1.0 and 10.0.",
    definitionOfDone: ["A rating in range", "A clear rationale", "Required data gathered"],
    validators: [
      {
        id: "rating-range",
        kind: "numeric",
        source: { outputPath: "rating" },
        operator: "between",
        min: 1,
        max: 10,
      },
      {
        id: "rationale",
        kind: "rubric",
        target: "output",
        criteria: [{ id: "clarity", description: "Rationale a human analyst would accept" }],
        passThreshold: 0.7,
      },
      {
        id: "gathered-data",
        kind: "trace",
        require: [
          { tool: "fetch_price", argsInclude: { ticker: "NVDA" } },
          { tool: "fetch_filing" },
          { tool: "fetch_news", minCount: 5 },
        ],
      },
    ],
    protectedPaths: ["validators/"],
  },
  holdoutValidators: [
    {
      id: "rating-precision",
      kind: "numeric",
      source: { outputPath: "rating" },
      operator: "neq",
      value: 5,
      fixHint: "A flat 5.0 is a non-answer.",
    },
  ],
  hiddenPaths: ["answers/"],
};

const judge: GoalJudge = (request) => ({
  criteria: request.criteria.map((criterion) => ({
    criterionId: criterion.id,
    score: request.subject.includes("because") ? 0.9 : 0.2,
    ...(request.subject.includes("because") ? {} : { improvement: "Explain why." }),
  })),
});

function goodEvents(runId: string): CanonicalEvent[] {
  return [
    tool(runId, "fetch_price", { ticker: "NVDA" }),
    tool(runId, "fetch_filing", { form: "10-K" }),
    ...Array.from({ length: 5 }, (_, index) => tool(runId, "fetch_news", { index })),
    spend(runId, 1000, 0.01),
  ];
}

function record(overrides: Partial<GoalEvalTrialRecord> = {}): GoalEvalTrialRecord {
  return {
    caseId: "nvda-rating",
    trialId: "t1",
    runId: "run-1",
    outputText: JSON.stringify({ rating: 7.5, note: "Buy because margins keep expanding." }),
    events: goodEvents("run-1"),
    ...overrides,
  };
}

const suite: GoalEvalSuiteSpec = {
  kind: "generic-ai.goal-eval-suite",
  id: "research-suite",
  title: "Research company template",
  cases: [nvdaCase],
  trials: { count: 3 },
  gate: { minPassRate: 0.6, minPassK: 0.3, maxTokensPerCompletedGoal: 5000 },
};

describe("pass^k", () => {
  it("is the chance that k attempts in a row all pass, not pass@k", () => {
    expect(estimatePassHatK(5, 5, 5)).toBe(1);
    expect(estimatePassHatK(2, 5, 5)).toBe(0);
    expect(estimatePassHatK(4, 5, 2)).toBeCloseTo((4 * 3) / (5 * 4));
    expect(estimatePassHatK(1, 2, 3)).toBeCloseTo(0.125);
    expect(estimatePassHatK(0, 0, 1)).toBe(0);
  });
});

describe("parseGoalEvalSuite", () => {
  it("accepts a valid suite", () => {
    expect(parseGoalEvalSuite(suite).ok).toBe(true);
  });

  it("reports bad goals, duplicate cases, bad holdouts, and bad gates with paths", () => {
    const parsed = parseGoalEvalSuite({
      kind: "generic-ai.goal-eval-suite",
      id: "bad",
      cases: [
        nvdaCase,
        { ...nvdaCase, holdoutValidators: [{ id: "x", kind: "numeric" }] },
        {
          id: "no-checks",
          goal: { id: "g", objective: "o", definitionOfDone: [], validators: [] },
        },
      ],
      gate: { minPassRate: 2 },
    });
    expect(parsed.ok).toBe(false);
    const paths = parsed.ok ? [] : parsed.issues.map((issue) => issue.path);
    expect(paths).toContain("$.cases[1].id");
    expect(paths.some((path) => path.startsWith("$.cases[1].holdoutValidators"))).toBe(true);
    expect(paths.some((path) => path.startsWith("$.cases[2].goal"))).toBe(true);
    expect(paths).toContain("$.gate.minPassRate");
  });
});

describe("scoreGoalEvalTrial", () => {
  it("scores the three NOVA checks from the trace and reads usage from events", async () => {
    const score = await scoreGoalEvalTrial(nvdaCase, record(), { judges: judge, now: fixedNow });
    expect(score.passed).toBe(true);
    expect(score.goalComplete).toBe(true);
    expect(score.holdoutComplete).toBe(true);
    expect(score.checks.numeric).toEqual({ total: 2, passed: 2, score: 1 });
    expect(score.checks.rubric?.score).toBeCloseTo(0.9);
    expect(score.checks.trace).toEqual({ total: 1, passed: 1, score: 1 });
    expect(score.usage).toMatchObject({ totalTokens: 1000, costUsd: 0.01, responses: 1 });
    expect(score.integrity).toEqual([]);
  });

  it("fails when required actions are missing and names the check", async () => {
    const score = await scoreGoalEvalTrial(
      nvdaCase,
      record({ events: [tool("run-1", "fetch_price", { ticker: "NVDA" })] }),
      { judges: judge },
    );
    expect(score.passed).toBe(false);
    expect(score.failedValidators).toEqual(["gathered-data"]);
  });

  it("fails a run that passes visible checks but misses a held-out one", async () => {
    const score = await scoreGoalEvalTrial(
      nvdaCase,
      record({ outputText: JSON.stringify({ rating: 5, note: "Hold because it is fine." }) }),
      { judges: judge },
    );
    expect(score.goalComplete).toBe(true);
    expect(score.holdoutComplete).toBe(false);
    expect(score.passed).toBe(false);
    expect(score.failedValidators).toEqual(["holdout:rating-precision"]);
  });

  it("flags reading the answer key and writing validator files", async () => {
    const score = await scoreGoalEvalTrial(
      nvdaCase,
      record({
        events: [
          ...goodEvents("run-1"),
          tool("run-1", "read_file", { path: "answers/nvda.json" }),
          tool("run-1", "bash", { command: "echo pass > validators/check.sh" }),
        ],
      }),
      { judges: judge },
    );
    expect(score.goalComplete).toBe(false);
    expect(score.passed).toBe(false);
    expect(score.integrity.map((finding) => finding.code).sort()).toEqual([
      "hidden_path_access",
      "protected_path_write",
    ]);
  });

  it("catches an in-run COMPLETE claim the eval cannot reproduce, and a swapped goal", async () => {
    const sealed = sealGoalEvalCase(nvdaCase);
    const events = [
      tool("run-1", "fetch_price", { ticker: "NVDA" }),
      createCanonicalEvent({
        ...context("run-1"),
        name: "plugin.goals.goal.validated",
        data: { goalId: "nvda-rating", goalFingerprint: "f".repeat(64), status: "COMPLETE" },
      }),
      createCanonicalEvent({
        ...context("run-1"),
        name: "plugin.goals.goal.completed",
        data: { goalId: "nvda-rating", goalFingerprint: sealed.goal.fingerprint },
      }),
    ];
    const score = await scoreGoalEvalTrial(nvdaCase, record({ events }), {
      judges: judge,
      sealed,
    });
    expect(score.integrity.map((finding) => finding.code).sort()).toEqual([
      "completion_claim_mismatch",
      "goal_fingerprint_mismatch",
    ]);
    expect(score.integrity.every((finding) => finding.evidenceRefs.length > 0)).toBe(true);
  });

  it("derives token and tool metrics that numeric validators can check", async () => {
    const lean: GoalEvalCaseSpec = {
      id: "lean",
      goal: {
        id: "lean",
        objective: "Answer cheaply.",
        definitionOfDone: ["Under 500 tokens"],
        validators: [
          {
            id: "token-budget",
            kind: "numeric",
            source: { metric: GOAL_EVAL_DERIVED_METRICS.totalTokens },
            operator: "lte",
            value: 500,
          },
        ],
      },
    };
    const score = await scoreGoalEvalTrial(lean, {
      caseId: "lean",
      trialId: "t1",
      events: [spend("run-1", 800, 0.02)],
    });
    expect(score.passed).toBe(false);
    expect(score.report.results[0]?.observed).toBe(800);
  });

  it("fails an attempt whose run did not finish even if output looks right", async () => {
    const score = await scoreGoalEvalTrial(nvdaCase, record({ runStatus: "cancelled" }), {
      judges: judge,
    });
    expect(score.goalComplete).toBe(true);
    expect(score.passed).toBe(false);
  });
});

describe("summarizeGoalEval and the gate", () => {
  it("rolls up pass^k, tokens per completed goal, and ranked findings", async () => {
    const results = await Promise.all([
      scoreGoalEvalTrial(nvdaCase, record({ trialId: "t1" }), { judges: judge }),
      scoreGoalEvalTrial(nvdaCase, record({ trialId: "t2" }), { judges: judge }),
      scoreGoalEvalTrial(
        nvdaCase,
        record({
          trialId: "t3",
          events: [tool("run-3", "fetch_filing", {}), spend("run-3", 2000, 0.02)],
        }),
        { judges: judge },
      ),
    ]);
    const report = summarizeGoalEval(suite, results, { now: fixedNow });
    expect(report.passed).toBe(2);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.cases[0]?.passK).toMatchObject({ k: 3, passCount: 2, value: 0 });
    expect(report.efficiency.totalTokens).toBe(4000);
    expect(report.efficiency.tokensPerCompletedGoal).toBe(2000);
    expect(report.efficiency.costPerCompletedGoalUsd).toBeCloseTo(0.02);
    expect(report.findings[0]).toMatchObject({
      caseId: "nvda-rating",
      validatorId: "gathered-data",
      failures: 1,
      trials: 3,
    });
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons.join("\n")).toContain("pass^3");

    const markdown = renderGoalEvalMarkdown(report);
    expect(markdown).toContain("Gate: **FAILED**");
    expect(markdown).toContain("Tokens per completed goal: 2000");
    expect(markdown).toContain("Required actions");
    expect(markdown).toContain("gathered-data");
  });

  it("fails the gate on any integrity violation by default", async () => {
    const cheat = await scoreGoalEvalTrial(
      nvdaCase,
      record({ events: [...goodEvents("run-1"), tool("run-1", "grep", { path: "answers/" })] }),
      { judges: judge },
    );
    const report = summarizeGoalEval({ ...suite, gate: {} }, [cheat]);
    expect(report.integrityViolations).toBe(1);
    expect(report.gate.passed).toBe(false);
    expect(renderGoalEvalMarkdown(report)).toContain("hidden_path_access");
  });

  it("does not treat attempts without usage evidence as free", async () => {
    const score = await scoreGoalEvalTrial(
      nvdaCase,
      record({ events: goodEvents("r").slice(0, 7) }),
      {
        judges: judge,
      },
    );
    const report = summarizeGoalEval(suite, [score]);
    expect(report.efficiency.attemptsWithoutUsage).toBe(1);
    expect(report.efficiency.tokensPerCompletedGoal).toBeNull();
    expect(report.gate.reasons.join("\n")).toContain("No usage evidence");
  });
});

describe("runGoalEvalSuite", () => {
  it("replays each case, shows the agent only visible checks, and survives executor errors", async () => {
    const prompts: string[] = [];
    let call = 0;
    const report = await runGoalEvalSuite({
      suite,
      judges: judge,
      now: fixedNow,
      execute: async (attempt) => {
        prompts.push(attempt.prompt);
        call += 1;
        if (call === 2) {
          throw new Error("provider timeout");
        }
        return {
          runId: attempt.trialId,
          outputText: JSON.stringify({ rating: 8, note: "Buy because demand is strong." }),
          events: goodEvents(attempt.trialId),
        };
      },
    });
    expect(report.trials).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.results.map((result) => result.trialId)).toEqual([
      "nvda-rating:trial:1",
      "nvda-rating:trial:2",
      "nvda-rating:trial:3",
    ]);
    expect(report.results[1]).toMatchObject({
      runStatus: "failed",
      failureMessage: "provider timeout",
    });
    expect(report.findings[0]).toMatchObject({
      validatorId: "run.failed",
      message: "provider timeout",
    });
    expect(prompts[0]).toContain("rating-range");
    expect(prompts[0]).toContain("Use the research CLI");
    expect(prompts[0]).not.toContain("rating-precision");
    expect(prompts[0]).not.toContain("answers/");
  });
});

describe("goalEvalRecordFromRunStore", () => {
  it("scores a stored production run from its event log", async () => {
    const events = goodEvents("run-9");
    const run: RunRecord = {
      runId: "run-9",
      version: 2,
      createdAt: "2026-11-26T10:00:00.000Z",
      updatedAt: "2026-11-26T10:00:05.000Z",
      envelope: {
        kind: "run-envelope",
        runId: "run-9",
        rootScopeId: "scope/root",
        mode: "async",
        status: "succeeded",
        timestamps: {
          createdAt: "2026-11-26T10:00:00.000Z",
          startedAt: "2026-11-26T10:00:01.000Z",
          completedAt: "2026-11-26T10:00:05.000Z",
        },
        output: {
          kind: "output-envelope",
          pluginId: "output-default",
          contentType: "text/plain",
          payload: { outputText: JSON.stringify({ rating: 6.5, note: "Buy because of growth." }) },
        },
      },
    };
    const store: Pick<RunStoreContract, "getRun" | "readEvents"> = {
      getRun: async <TOutput>(runId: string) =>
        (runId === "run-9" ? run : undefined) as RunRecord<TOutput> | undefined,
      readEvents: async () => events,
    };
    const stored = await goalEvalRecordFromRunStore(store, "run-9", { caseId: "nvda-rating" });
    expect(stored).toMatchObject({ trialId: "run-9", runStatus: "succeeded", durationMs: 4000 });
    const score = await scoreGoalEvalTrial(nvdaCase, stored, { judges: judge });
    expect(score.passed).toBe(true);
    await expect(goalEvalRecordFromRunStore(store, "missing", { caseId: "x" })).rejects.toThrow(
      "not in the run store",
    );
  });
});
