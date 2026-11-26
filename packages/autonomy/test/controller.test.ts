import { describe, expect, it } from "vitest";

import {
  AutonomousDriver,
  createAutonomousRuntimeState,
  createGoalTools,
  type GateCommandResult,
  GoalDriver,
  LongRunController,
} from "../src/index.js";
import { clock, turn, usage } from "./helpers.js";

function tool(driver: GoalDriver, name: string, options?: Parameters<typeof createGoalTools>[1]) {
  const found = createGoalTools(driver, options).find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }
  return (params: Record<string, unknown> = {}) =>
    found.execute("call", params as never).then((result) => result.details);
}

describe("goal tools", () => {
  it("gets, creates and completes a goal", async () => {
    const driver = new GoalDriver();
    expect(await tool(driver, "get_goal")()).toEqual({
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    });
    const created = await tool(driver, "create_goal")({ objective: "ship it", token_budget: 500 });
    expect(created.goal.status).toBe("active");
    await expect(tool(driver, "create_goal")({ objective: "again" })).rejects.toThrow(
      "already has an active goal",
    );
    driver.recordAssistantUsage("m1", usage(100, 20));
    const done = await tool(driver, "complete_goal")();
    expect(done.goal.status).toBe("complete");
    expect(done.completionBudgetReport).toContain("tokens used: 120 of 500");
    expect((await tool(driver, "create_goal")({ objective: "next" })).goal.objective).toBe("next");
  });

  it("refuses a completion claim the host's checks reject", async () => {
    const driver = new GoalDriver();
    driver.start("ship it");
    let passing = false;
    const verify = () =>
      passing ? { passed: true } : { passed: false, feedback: "tests still fail" };
    const refused = await tool(driver, "complete_goal", { verify })();
    expect(refused).toMatchObject({ verified: false, feedback: "tests still fail" });
    expect(driver.state.status).toBe("active");
    passing = true;
    expect((await tool(driver, "complete_goal", { verify })()).goal.status).toBe("complete");
    await expect(tool(new GoalDriver(), "complete_goal")()).rejects.toThrow("has no goal");
  });

  it("leaves out create_goal when asked", () => {
    expect(createGoalTools(new GoalDriver(), { create: false }).map((entry) => entry.name)).toEqual(
      ["get_goal", "complete_goal"],
    );
  });
});

describe("long-run controller", () => {
  it("continues an active goal, then hands over to autonomous gates once it is complete", async () => {
    const goal = new GoalDriver();
    goal.start("ship it");
    const results: GateCommandResult[] = [
      { status: 0, stdout: "", stderr: "", timedOut: false, outputTruncated: false },
    ];
    const autonomous = new AutonomousDriver(
      createAutonomousRuntimeState({ enabled: true, gates: { commands: ["true"] } }),
      { runGate: async () => results[0] as GateCommandResult },
    );
    const controller = new LongRunController({ goal, autonomous });
    const first = await controller.afterTurn(turn(Date.now() + 1, { text: "working" }));
    expect(first).toMatchObject({ kind: "continue", source: "goal" });
    goal.complete();
    const second = await controller.afterTurn(turn(Date.now() + 2, { text: "done" }));
    expect(second).toMatchObject({
      kind: "stop",
      goal: { status: "complete" },
      autonomous: { reason: { kind: "gate-passed" } },
    });
  });

  it("gives one wrap-up turn when the budget is reached", async () => {
    const goal = new GoalDriver();
    goal.start("ship it", 50);
    const controller = new LongRunController({ goal });
    controller.accountMessage(turn(Date.now() + 1, { text: "x", usage: usage(40, 20) }), "m1");
    expect(goal.state.status).toBe("budget_limited");
    const wrapUp = await controller.afterTurn(turn(Date.now() + 1, { text: "x" }));
    expect(wrapUp.kind === "continue" && wrapUp.text.startsWith("[goal: budget-limit]")).toBe(true);
    expect((await controller.afterTurn(turn(Date.now() + 2, { text: "wrapped" }))).kind).toBe(
      "stop",
    );
  });

  it("waits out a no-progress backoff and stops at the cap", async () => {
    const time = clock(Date.now());
    const goal = new GoalDriver({ now: time.now });
    goal.start("ship it");
    const slept: number[] = [];
    const controller = new LongRunController({
      goal,
      now: time.now,
      sleep: async (ms) => {
        slept.push(ms);
        time.advance(ms);
      },
    });
    const created = goal.state.createdAt as number;
    expect((await controller.afterTurn(turn(created + 1))).kind).toBe("continue");
    expect((await controller.afterTurn(turn(created + 2))).kind).toBe("continue");
    const stop = await controller.afterTurn(turn(created + 3));
    expect(slept).toEqual([10_000, 20_000]);
    expect(stop).toMatchObject({ kind: "stop", goal: { status: "error" } });
  });

  it("stops at once on an aborted turn", async () => {
    const goal = new GoalDriver();
    goal.start("ship it");
    const controller = new LongRunController({ goal });
    expect((await controller.afterTurn(turn(Date.now() + 1, { stopReason: "aborted" }))).kind).toBe(
      "stop",
    );
    expect(goal.state.status).toBe("active");
  });
});
