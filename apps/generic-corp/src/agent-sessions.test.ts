import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentSessionFiles } from "./agent-sessions.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function turn(taskId: string, attempt = 1) {
  return {
    taskId,
    attemptRunId: `${taskId}-${attempt}`,
    rootTaskId: "goal/1",
    agentId: "ceo",
    role: "ceo",
    prompt: "p",
    workspaceRoot: "/unused",
  };
}

describe("agent session files", () => {
  it("resumes only a cut-off attempt at the same task", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "generic-corp-agent-sessions-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const sessions = createAgentSessionFiles(root);
    const file = sessions.sessionFile(turn("t1"));
    expect(file).toBe(path.join(root, "ceo", "goal_1.jsonl"));

    // Nothing saved yet: a fresh start even though the marker names this task.
    expect(await sessions.begin(turn("t1"))).toEqual({ file });
    writeFileSync(file, "{}\n");
    // The first attempt never settled (a restart): the next attempt resumes.
    expect(await sessions.begin(turn("t1", 2))).toEqual({ file, resume: true });
    // A retryable failure keeps it resumable.
    await sessions.settle(turn("t1", 2), true);
    expect(await sessions.begin(turn("t1", 3))).toEqual({ file, resume: true });
    // A finished turn clears it: the same task's next turn and other tasks send their prompt.
    await sessions.settle(turn("t1", 3), false);
    expect(await sessions.begin(turn("t1", 4))).toEqual({ file });
    expect(await sessions.begin(turn("t2"))).toEqual({ file });
  });
});
