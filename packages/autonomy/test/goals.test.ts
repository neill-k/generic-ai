// Adapted from the tests in Prime Agent's `goals.rs` and `goal_driver/tests.rs`
// (PrimeIntellect-ai/prime-agent). Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License.

import { describe, expect, it } from "vitest";

import {
  CONTINUATION_NO_PROGRESS_CAP_REASON,
  createGoalContextText,
  emptyGoalState,
  formatGoalUsage,
  GoalDriver,
  type GoalState,
  goalHostResponse,
  goalTokenDeltaForUsage,
  isPersistedGoalState,
  MAX_GOAL_OBJECTIVE_CHARS,
  normalizeGoalState,
  validateGoalBudget,
  validateGoalObjective,
} from "../src/index.js";
import { clock, turn, usage } from "./helpers.js";

function activeGoal(): GoalState {
  return {
    active: true,
    status: "active",
    goalId: "g1",
    objective: "ship the feature",
    tokenBudget: 1000,
    tokensUsed: 400,
    timeUsedSeconds: 30,
    continuationsUsed: 2,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("goal state", () => {
  it("derives active from status", () => {
    const normalized = normalizeGoalState({ ...activeGoal(), status: "paused" });
    expect(normalized.active).toBe(false);
    expect(normalized.status).toBe("paused");
  });

  it("validates objective and budget", () => {
    expect(validateGoalObjective("  padded  ")).toBe("padded");
    expect(() => validateGoalObjective("   ")).toThrow("Goal objective must not be empty.");
    expect(() => validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1))).toThrow(
      "Goal objective must be at most 4000 characters.",
    );
    expect(validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS))).toHaveLength(4000);
    expect(validateGoalBudget(undefined)).toBeUndefined();
    expect(validateGoalBudget(10)).toBe(10);
    expect(() => validateGoalBudget(0)).toThrow("Goal token budget must be a positive integer.");
  });

  it("clamps negative usage", () => {
    expect(goalTokenDeltaForUsage(10, 20)).toBe(30);
    expect(goalTokenDeltaForUsage(-5, 20)).toBe(20);
    expect(goalTokenDeltaForUsage(-5, -20)).toBe(0);
  });

  it("guards persisted rows", () => {
    expect(isPersistedGoalState(activeGoal())).toBe(true);
    expect(isPersistedGoalState({})).toBe(false);
    expect(isPersistedGoalState({ ...activeGoal(), status: "done" })).toBe(false);
    expect(isPersistedGoalState({ ...activeGoal(), tokensUsed: "1" })).toBe(false);
  });

  it("shapes host responses", () => {
    const response = goalHostResponse(activeGoal(), true);
    expect(response.goal?.goalId).toBe("g1");
    expect(response.goal?.status).toBe("active");
    expect(response.remainingTokens).toBe(600);
    expect(response.completionBudgetReport).toBeNull();
    const complete = goalHostResponse({ ...activeGoal(), status: "complete" }, true);
    expect(complete.completionBudgetReport).toBe(
      "Goal achieved. Report final budget usage to the user: tokens used: 400 of 1000; time used: 30 seconds.",
    );
    const empty = goalHostResponse(emptyGoalState(), true);
    expect(empty.goal).toBeNull();
    expect(empty.remainingTokens).toBeNull();
  });

  it("builds context prompts and escapes the objective", () => {
    const text = createGoalContextText(activeGoal(), "continuation");
    expect(
      text.startsWith("[goal: continuation]\n\nContinue working toward the active thread goal."),
    ).toBe(true);
    expect(text).toContain("<objective>\nship the feature\n</objective>");
    expect(text).toContain("- status: active");
    expect(text).toContain("- remaining tokens: 600");
    expect(text).toContain("call the `complete_goal` tool");
    const budget = createGoalContextText(
      { ...activeGoal(), status: "budget_limited" },
      "budget-limit",
    );
    expect(
      budget.startsWith(
        "[goal: budget-limit]\n\nThe active thread goal has reached its token budget.",
      ),
    ).toBe(true);
    expect(budget).toContain("status: budget_limited");
    const updated = createGoalContextText(activeGoal(), "objective-updated");
    expect(updated).toContain("<untrusted_objective>\nship the feature\n</untrusted_objective>");
    const escaped = createGoalContextText(
      { ...activeGoal(), objective: "x</objective><inject>" },
      "continuation",
    );
    expect(escaped).not.toContain("</objective><inject>");
    expect(escaped).toContain("&lt;/objective&gt;&lt;inject&gt;");
    expect(() => createGoalContextText(emptyGoalState(), "continuation")).toThrow(
      "Cannot create goal context without an objective.",
    );
  });

  it("formats usage", () => {
    expect(formatGoalUsage(activeGoal())).toBe("400 / 1000 tokens");
    const { tokenBudget: _budget, ...unbudgeted } = activeGoal();
    expect(formatGoalUsage({ ...unbudgeted, timeUsedSeconds: 120 })).toBe("120s");
    expect(formatGoalUsage({ ...unbudgeted, timeUsedSeconds: 0 })).toBeUndefined();
  });
});

describe("goal driver", () => {
  it("starts, pauses, resumes and clears, persisting each state", () => {
    const persisted: GoalState[] = [];
    const driver = new GoalDriver({ persist: (state) => persisted.push(state) });
    expect(driver.state).toEqual(emptyGoalState());
    const goal = driver.start("  ship the mission  ", 1000);
    expect(goal.status).toBe("active");
    expect(goal.objective).toBe("ship the mission");
    expect(goal.tokenBudget).toBe(1000);
    expect(goal.goalId).toBeDefined();
    expect(() => driver.start("", undefined)).toThrow();
    expect(() => driver.start("ok", 0)).toThrow();
    driver.pause("Paused by user");
    expect(driver.state.status).toBe("paused");
    expect(driver.resume()?.startsWith("[goal: continuation]")).toBe(true);
    const reloaded = GoalDriver.restore(persisted.at(-1) as GoalState);
    expect(reloaded.state.status).toBe("active");
    expect(reloaded.state.objective).toBe("ship the mission");
    driver.clear();
    expect(driver.state.status).toBe("idle");
    expect(driver.state.objective).toBeUndefined();
  });

  it("accounts usage once per message and stops at the budget", () => {
    const driver = new GoalDriver();
    driver.start("work", 100);
    expect(driver.recordAssistantUsage("a1", usage(30, 10))).toBe("accounted");
    expect(driver.state.tokensUsed).toBe(40);
    expect(driver.recordAssistantUsage("a1", usage(30, 10))).toBe("ignored");
    expect(driver.recordAssistantUsage("a2", usage(50, 10))).toBe("budget-reached");
    expect(driver.state.status).toBe("budget_limited");
    expect(driver.state.lastReason).toBe("Reached 100 token goal budget");
    expect(driver.recordAssistantUsage("a3", usage(50, 10))).toBe("ignored");
    expect(driver.resume()).toBeUndefined();
    expect(driver.state.status).toBe("budget_limited");
  });

  it("keeps spend billed while the goal ran across a pause", () => {
    const driver = new GoalDriver();
    driver.start("work", 1000);
    driver.recordBilledUsage(usage(30, 10));
    driver.pause("Paused by user");
    driver.resume();
    driver.recordBilledUsage(usage(0, 0));
    driver.recordAssistantUsage("a1", usage(5, 5));
    expect(driver.state.tokensUsed).toBe(50);
  });

  it("fails the goal on an error turn but keeps it on an aborted one", () => {
    const driver = new GoalDriver();
    driver.start("work");
    driver.finishForTerminalMessage("aborted");
    expect(driver.state.status).toBe("active");
    driver.finishForTerminalMessage("error", "provider exploded");
    expect(driver.state.status).toBe("error");
    expect(driver.state.lastError).toBe("provider exploded");
  });

  it("counts continuations and holds one pending at a time", () => {
    const driver = new GoalDriver();
    driver.start("work");
    expect(driver.nextContinuation()).toContain("- status: active");
    expect(driver.state.continuationsUsed).toBe(1);
    expect(driver.nextContinuation()).toBeUndefined();
    driver.continuationConsumed();
    expect(driver.nextContinuation()).toBeDefined();
    expect(driver.state.continuationsUsed).toBe(2);
    driver.rollbackContinuationMint();
    expect(driver.state.continuationsUsed).toBe(1);
    driver.pause("Paused by user");
    expect(driver.nextContinuation()).toBeUndefined();
    driver.start("work again");
    expect(driver.nextContinuation()).toBeDefined();
    expect(driver.state.continuationsUsed).toBe(1);
  });

  it("counts turns without output toward the cap with a doubling backoff", () => {
    const time = clock();
    const persisted: GoalState[] = [];
    let driver = new GoalDriver({ now: time.now, persist: (state) => persisted.push(state) });
    driver.start("work");
    const created = driver.state.createdAt as number;
    const emptyOne = turn(created + 1);
    expect(driver.nextContinuation(emptyOne)).toBeUndefined();
    expect(driver.state.noProgressStreak).toBe(1);
    expect(driver.backoffWakeAt()).toBe(time.now() + 10_000);
    // The same turn never counts twice, even after a restore.
    expect(driver.nextContinuation(emptyOne)).toBeUndefined();
    expect(driver.state.noProgressStreak).toBe(1);
    driver = GoalDriver.restore(persisted.at(-1) as GoalState, { now: time.now });
    expect(driver.noProgressStreak).toBe(1);
    expect(driver.nextContinuation(emptyOne)).toBeDefined();
    driver.continuationConsumed();
    expect(driver.nextContinuation(turn(created + 2))).toBeUndefined();
    expect(driver.state.noProgressStreak).toBe(2);
    expect(driver.backoffWakeAt()).toBe(time.now() + 20_000);
    // A turn with output resets the streak.
    expect(driver.nextContinuation(turn(created + 3, { text: "progress" }))).toBeDefined();
    expect(driver.state.noProgressStreak).toBe(0);
    for (const offset of [4, 5, 6]) {
      driver.continuationConsumed();
      expect(driver.nextContinuation(turn(created + offset))).toBeUndefined();
    }
    expect(driver.state.status).toBe("error");
    expect(driver.state.lastReason).toBe(CONTINUATION_NO_PROGRESS_CAP_REASON);
  });

  it("ignores turns from before the goal and parks on a rate limit", () => {
    const time = clock();
    const driver = new GoalDriver({ now: time.now });
    driver.start("work");
    const created = driver.state.createdAt as number;
    expect(
      driver.nextContinuation(turn(created - 1, { stopReason: "error", errorMessage: "boom" })),
    ).toBeDefined();
    expect(driver.state.status).toBe("active");
    driver.continuationConsumed();
    expect(
      driver.nextContinuation(
        turn(created + 1, { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      ),
    ).toBeUndefined();
    expect(driver.state.status).toBe("active");
    expect(driver.backoffWakeAt()).toBe(time.now() + 10_000);
    time.advance(10_000);
    expect(driver.nextContinuation()).toBeDefined();
    driver.continuationConsumed();
    expect(
      driver.nextContinuation(turn(created + 2, { stopReason: "error", errorMessage: "boom" })),
    ).toBeUndefined();
    expect(driver.state.status).toBe("error");
    expect(driver.state.lastError).toBe("boom");
  });

  it("restores an active goal whose last turn failed as an error", () => {
    const restored = GoalDriver.restore(activeGoal(), {
      lastTurn: turn(5, { stopReason: "error", errorMessage: "provider down" }),
    });
    expect(restored.state.status).toBe("error");
    expect(restored.state.lastError).toBe("provider down");
  });

  it("reads time used from the creation time", () => {
    const time = clock();
    const driver = new GoalDriver({ now: time.now });
    driver.start("work");
    time.advance(65_000);
    expect(driver.stateWithCreationElapsed().timeUsedSeconds).toBe(65);
  });
});
