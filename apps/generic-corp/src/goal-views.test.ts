import type { AgentTaskRecord } from "@generic-ai/plugin-delegation";
import { describe, expect, it } from "vitest";

import { checklistOf, goalStateOf, taskStatusText } from "./goal-views.js";

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
});
