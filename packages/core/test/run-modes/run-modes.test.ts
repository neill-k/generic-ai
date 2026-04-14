import { describe, expect, it } from "vitest";
import { createManualScheduler } from "../../src/scheduler/manual-scheduler.js";
import { createAsyncRunMode, createSyncRunMode } from "../../src/run-modes/run-modes.js";
import { createRunSessionMachine } from "../../src/run-modes/session-machine.js";

describe("run modes", () => {
  it("runs sync work inline on the shared session machinery", () => {
    const machine = createRunSessionMachine();
    const syncMode = createSyncRunMode({ sessions: machine });
    const seen: string[] = [];

    const result = syncMode.run((session) => {
      seen.push(session.mode);
      seen.push(session.state);
      const child = session.createChild({ id: "sync-child" });
      seen.push(child.mode);
      seen.push(child.state);
      child.start();
      child.succeed("child-done");
      return "done";
    }, { id: "sync-root" });

    expect(result).toBe("done");
    expect(seen).toEqual(["sync", "running", "sync", "idle"]);
  });

  it("defers async work through an injected scheduler", async () => {
    const scheduler = createManualScheduler();
    const machine = createRunSessionMachine();
    const asyncMode = createAsyncRunMode({ scheduler, sessions: machine });
    const seen: string[] = [];

    const run = asyncMode.run(async (session) => {
      seen.push(session.mode);
      seen.push(session.state);
      session.emit("async-task-started");
      return "async-done";
    }, { id: "async-root" });

    expect(seen).toEqual([]);
    expect(scheduler.pendingCount).toBe(1);

    await scheduler.flushAll();

    await expect(run).resolves.toBe("async-done");
    expect(seen).toEqual(["async", "running"]);
  });
});
