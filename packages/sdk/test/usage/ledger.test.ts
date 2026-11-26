import { describe, expect, it } from "vitest";

import { createCanonicalEvent } from "../../src/events/index.js";
import {
  addUsageTotals,
  createUsageLedger,
  emptyUsageTotals,
  evaluateUsageBudget,
  hasUsageBudget,
  type ModelUsage,
  summarizeUsageEvents,
  usageTotalsFromModelUsage,
} from "../../src/usage/index.js";

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

const context = (runId: string, sessionId = `${runId}:root`) => ({
  scopeId: "scope/root",
  runId,
  rootSessionId: `${runId}:root`,
  sessionId,
});

describe("usage totals", () => {
  it("converts one response and sums totals", () => {
    const one = usageTotalsFromModelUsage({ ...usage(100, 20, 0.01), reasoning: 5 });
    expect(one).toMatchObject({
      responses: 1,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
      costUsd: 0.01,
    });
    const two = addUsageTotals(one, one);
    expect(two.responses).toBe(2);
    expect(two.totalTokens).toBe(240);
    expect(two.costUsd).toBeCloseTo(0.02);
    expect(addUsageTotals(emptyUsageTotals, one)).toEqual(one);
  });

  it("falls back to the token parts and cost parts when totals are missing", () => {
    const totals = usageTotalsFromModelUsage({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 0,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(totals.totalTokens).toBe(20);
    expect(totals.costUsd).toBeCloseTo(0.3);
  });

  it("ignores negative and non-finite numbers", () => {
    const totals = usageTotalsFromModelUsage({
      input: -1,
      output: Number.NaN,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.POSITIVE_INFINITY,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -3 },
    });
    expect(totals.totalTokens).toBe(0);
    expect(totals.costUsd).toBe(0);
  });
});

describe("usage budgets", () => {
  const totals = addUsageTotals(usageTotalsFromModelUsage(usage(600, 400, 0.5)), emptyUsageTotals);

  it("reports remaining headroom under the caps", () => {
    expect(evaluateUsageBudget(totals, { maxTokens: 1500, maxCostUsd: 1 })).toEqual({
      exceeded: false,
      breaches: [],
      remainingTokens: 500,
      remainingCostUsd: 0.5,
    });
  });

  it("counts a cap as exceeded once the total reaches it", () => {
    const status = evaluateUsageBudget(totals, { maxTokens: 1000, maxCostUsd: 0.25 });
    expect(status.exceeded).toBe(true);
    expect(status.breaches).toEqual([
      { limit: "tokens", max: 1000, used: 1000 },
      { limit: "cost_usd", max: 0.25, used: 0.5 },
    ]);
    expect(status.remainingTokens).toBe(0);
    expect(status.remainingCostUsd).toBe(0);
  });

  it("treats missing or invalid caps as no cap", () => {
    expect(evaluateUsageBudget(totals, undefined).exceeded).toBe(false);
    expect(hasUsageBudget({})).toBe(false);
    expect(hasUsageBudget({ maxTokens: Number.NaN })).toBe(false);
    expect(hasUsageBudget({ maxCostUsd: 0 })).toBe(true);
  });
});

describe("usage ledger", () => {
  it("rolls usage up per run, agent, goal, and model", () => {
    const ledger = createUsageLedger();
    ledger.record({
      runId: "run-1",
      sessionId: "s-root",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: usage(100, 50, 0.1),
      roleId: "root",
      goalId: "goal-a",
    });
    ledger.record({
      runId: "run-1",
      sessionId: "s-builder",
      agentId: "builder-1",
      roleId: "builder",
      provider: "openai",
      model: "gpt-5.5",
      usage: usage(200, 100, 0.2),
      goalId: "goal-a",
    });
    const runTotals = ledger.record({
      runId: "run-1",
      sessionId: "s-root",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: usage(10, 10, 0.01),
    });

    expect(runTotals.totalTokens).toBe(470);
    expect(ledger.runTotals("run-1")).toEqual(runTotals);
    expect(ledger.runTotals("missing")).toEqual(emptyUsageTotals);

    const summary = ledger.summary();
    expect(summary.totals.totalTokens).toBe(470);
    expect(summary.byRun).toEqual([{ runId: "run-1", totals: runTotals }]);
    expect(
      summary.byAgent.map((entry) => [entry.agentId, entry.roleId, entry.totals.totalTokens]),
    ).toEqual([
      ["builder-1", "builder", 300],
      ["s-root", "root", 170],
    ]);
    expect(summary.byGoal.map((entry) => [entry.goalId, entry.totals.totalTokens])).toEqual([
      ["goal-a", 450],
    ]);
    expect(
      summary.byModel.map((entry) => [entry.provider, entry.model, entry.totals.responses]),
    ).toEqual([
      ["anthropic", "claude-opus-5-5", 2],
      ["openai", "gpt-5.5", 1],
    ]);
  });

  it("computes tokens per completed goal, charging failed attempts too", () => {
    const ledger = createUsageLedger();
    const record = (goalId: string, tokens: number) =>
      ledger.record({
        runId: `run-${goalId}`,
        provider: "faux",
        model: "faux-1",
        usage: usage(tokens, 0, tokens / 1000),
        goalId,
      });
    record("a", 1000);
    record("b", 3000);
    record("c", 2000);
    ledger.setGoalOutcome("a", "completed");
    ledger.setGoalOutcome("b", "completed");
    ledger.setGoalOutcome("c", "failed");

    const goals = ledger.summary().goals;
    expect(goals).toMatchObject({
      goalCount: 3,
      completedGoals: 2,
      failedGoals: 1,
      openGoals: 0,
      goalTokens: 6000,
      tokensPerCompletedGoal: 3000,
    });
    expect(goals.costPerCompletedGoalUsd).toBeCloseTo(3);
  });

  it("reports no tokens-per-goal figure before any goal completes", () => {
    const ledger = createUsageLedger();
    ledger.record({ runId: "r", provider: "p", model: "m", usage: usage(5, 5), goalId: "g" });
    expect(ledger.summary().goals.tokensPerCompletedGoal).toBeNull();
    expect(ledger.summary().goals.openGoals).toBe(1);
  });
});

describe("summarizeUsageEvents", () => {
  it("reads usage and goal outcomes from canonical events", () => {
    const events = [
      createCanonicalEvent({ ...context("run-1"), name: "run.started", data: { goalId: "g1" } }),
      createCanonicalEvent({
        ...context("run-1"),
        name: "usage.recorded",
        data: { provider: "anthropic", model: "claude-opus-5-5", usage: usage(100, 20, 0.05) },
      }),
      createCanonicalEvent({
        ...context("run-1", "run-1:planner"),
        name: "usage.recorded",
        data: {
          provider: "anthropic",
          model: "claude-opus-5-5",
          usage: usage(50, 30, 0.02),
          agentId: "planner",
          roleId: "planner",
        },
      }),
      createCanonicalEvent({ ...context("run-1"), name: "run.completed", data: { goalId: "g1" } }),
      createCanonicalEvent({
        ...context("run-2"),
        name: "usage.recorded",
        data: { provider: "openai", model: "gpt-5.5", usage: usage(400, 0), goalId: "g2" },
      }),
      createCanonicalEvent({
        ...context("run-2"),
        name: "plugin.goals.goal.failed",
        data: { goalId: "g2" },
      }),
      // Malformed usage events and unrelated events are ignored.
      createCanonicalEvent({
        ...context("run-3"),
        name: "usage.recorded",
        data: { provider: "openai", usage: { input: "lots" } },
      }),
      createCanonicalEvent({ ...context("run-3"), name: "tool.call.started", data: {} }),
    ];

    const summary = summarizeUsageEvents(events);

    expect(summary.totals.responses).toBe(3);
    expect(summary.totals.totalTokens).toBe(600);
    expect(summary.byGoal).toEqual([
      expect.objectContaining({ goalId: "g1", outcome: "completed" }),
      expect.objectContaining({ goalId: "g2", outcome: "failed" }),
    ]);
    expect(summary.byGoal[0]?.totals.totalTokens).toBe(200);
    expect(summary.goals.tokensPerCompletedGoal).toBe(600);
    expect(summary.byAgent.map((entry) => entry.agentId)).toEqual([
      "planner",
      "run-1:root",
      "run-2:root",
    ]);
  });
});
