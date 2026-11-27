import type { AgentTaskRecord } from "@generic-ai/plugin-delegation";
import { describe, expect, it } from "vitest";

import { checklistOf, dailySummary, goalStateOf, taskStatusText } from "./goal-views.js";
import type { CompanyRuntime } from "./runtime.js";

function task(overrides: Partial<AgentTaskRecord>): AgentTaskRecord {
  return {
    taskId: "goal",
    rootTaskId: "goal",
    agentId: "ceo",
    depth: 0,
    instruction: "Book a venue",
    status: "running",
    round: 1,
    childTaskIds: [],
    pendingChildTaskIds: [],
    runIds: [],
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as AgentTaskRecord;
}

const spec = {
  id: "goal",
  objective: "A venue.",
  definitionOfDone: ["Booked for 40 people.", "Under $12,000."],
  validators: [],
};

describe("goal views", () => {
  it("names goal states in plain words", () => {
    expect(goalStateOf(task({ status: "running", goalDraft: "pending" }))).toBe("drafting");
    expect(goalStateOf(task({ status: "running" }))).toBe("working");
    expect(goalStateOf(task({ status: "succeeded" }))).toBe("done");
    expect(goalStateOf(task({ status: "failed" }))).toBe("stopped");
    expect(goalStateOf(task({ status: "succeeded", impossible: { reason: "x" } as never }))).toBe(
      "impossible",
    );
    expect(taskStatusText(task({ status: "waiting", pendingApprovalIds: ["a"] }))).toBe(
      "Waiting on a permission.",
    );
  });

  it("ticks each line of done from the definition-of-done rubric", () => {
    const checklist = checklistOf(
      task({
        goal: { spec, fingerprint: "v2" } as never,
        lastGoalReport: {
          status: "INCOMPLETE",
          goalId: "goal",
          fingerprint: "v2",
          required: 1,
          passed: 0,
          failed: 1,
          errored: 0,
          feedback: "",
          evaluatedAt: "2026-11-27T00:00:00.000Z",
          checks: [
            {
              validatorId: "definition-of-done",
              kind: "rubric",
              required: true,
              status: "failed",
              message: "",
              criteria: [
                { criterionId: "dod-1", passed: true },
                { criterionId: "dod-2", passed: false },
              ],
            },
          ],
        },
      }),
    );
    expect(checklist).toEqual([
      { line: "Booked for 40 people.", state: "met" },
      { line: "Under $12,000.", state: "not-met" },
    ]);
  });

  it("shows lines as unchecked once the owner changed them after the last check", () => {
    const checklist = checklistOf(
      task({
        status: "succeeded",
        goal: { spec, fingerprint: "v3" } as never,
        lastGoalReport: {
          status: "COMPLETE",
          goalId: "goal",
          fingerprint: "v2",
          required: 1,
          passed: 1,
          failed: 0,
          errored: 0,
          feedback: "",
          evaluatedAt: "2026-11-27T00:00:00.000Z",
        },
      }),
    );
    expect(checklist.map((item) => item.state)).toEqual(["unchecked", "unchecked"]);
  });

  it("sums up the last day quietly, from records already kept", async () => {
    const old = "2026-11-25T00:00:00.000Z";
    const recent = "2026-11-27T10:00:00.000Z";
    const tasks = [
      task({
        taskId: "a",
        rootTaskId: "a",
        status: "succeeded",
        createdAt: old,
        updatedAt: recent,
      }),
      task({
        taskId: "a1",
        rootTaskId: "a",
        depth: 1,
        agentId: "vp",
        status: "succeeded",
        updatedAt: recent,
      }),
      task({
        taskId: "b",
        rootTaskId: "b",
        status: "failed",
        createdAt: recent,
        updatedAt: recent,
      }),
      task({
        taskId: "c",
        rootTaskId: "c",
        status: "running",
        createdAt: recent,
        updatedAt: recent,
      }),
      task({ taskId: "d", rootTaskId: "d", status: "succeeded", createdAt: old, updatedAt: old }),
    ];
    let since: string | undefined;
    const runtime = {
      listTasks: async () => tasks,
      org: {
        changes: async () => [
          { at: recent, summary: "The CEO hired a Head of Venues." },
          { at: old, summary: "Old news." },
        ],
      },
      costs: async (options: { since?: string }) => {
        since = options.since;
        return { totals: { totalTokens: 1200, costUsd: 0.5 } };
      },
    } as unknown as CompanyRuntime;
    const summary = await dailySummary(runtime, {
      now: new Date("2026-11-27T12:00:00.000Z"),
      refusals: { list: async () => [{ at: recent }, { at: old }] },
    });
    expect(since).toBe("2026-11-26T12:00:00.000Z");
    expect(summary.done.map((goal) => goal.goalId)).toEqual(["a"]);
    expect(summary.ended.map((goal) => goal.state)).toEqual(["stopped"]);
    expect(summary).toMatchObject({ started: 2, open: 1, handedIn: 1, refused: 1, costUsd: 0.5 });
    expect(summary.orgChanges).toEqual(["The CEO hired a Head of Venues."]);
    expect(summary.headline).toBe(
      "1 goal done. 1 goal ended without being done. 2 goals set. 1 piece of work handed in. 1 action refused. 1 change to the org. $0.50 spent.",
    );

    const quiet = await dailySummary(
      {
        ...runtime,
        listTasks: async () => [],
        costs: async () => ({ totals: { totalTokens: 0, costUsd: 0 } }),
        org: { changes: async () => [] },
      } as unknown as CompanyRuntime,
      { now: new Date("2026-11-27T12:00:00.000Z") },
    );
    expect(quiet.headline).toBe("Nothing happened. The office was quiet.");
  });
});
