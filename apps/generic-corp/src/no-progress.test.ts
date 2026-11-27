import type { AgentTaskExecutionInput } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import { runWithProgressCheck, TurnProgressMonitor } from "./no-progress.js";

const input: AgentTaskExecutionInput = {
  taskId: "t",
  attemptRunId: "a",
  rootTaskId: "t",
  agentId: "ceo",
  role: "ceo",
  prompt: "p",
  workspaceRoot: "/tmp",
};

function tool(name: string, execute: (params: unknown) => Promise<unknown> = async () => "ok") {
  return { name, description: name, execute: (_id: string, params: unknown) => execute(params) };
}

describe("no-progress check", () => {
  it("stops a turn that goes quiet, but not while a tool is running", async () => {
    let now = 0;
    const monitor = new TurnProgressMonitor({
      idleMs: 1_000,
      checkEveryMs: 60_000,
      now: () => now,
    });
    let release: () => void = () => {};
    const slow = monitor.wrap(
      tool("bash", () => new Promise<void>((resolve) => (release = () => resolve()))),
    );
    const call = slow.execute("1", { command: "make" });
    now = 5_000;
    monitor.check();
    expect(monitor.signal.aborted).toBe(false);
    release();
    await call;
    now = 5_500;
    monitor.check();
    expect(monitor.signal.aborted).toBe(false);
    now = 6_000;
    monitor.check();
    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.reason?.message).toMatch(/no progress/);
    monitor.dispose();
  });

  it("stops a turn that repeats the same call", async () => {
    const monitor = new TurnProgressMonitor({ maxRepeats: 3, checkEveryMs: 60_000 });
    const read = monitor.wrap(tool("read"));
    await read.execute("1", { path: "a" });
    await read.execute("2", { path: "b" });
    await read.execute("3", { path: "b" });
    expect(monitor.signal.aborted).toBe(false);
    await read.execute("4", { path: "b" });
    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.reason?.message).toMatch(/repeated the same read call 3 times/);
    monitor.dispose();
  });

  it("turns a stopped turn into a retryable failure", async () => {
    const result = await runWithProgressCheck(
      input,
      { idleMs: 20, checkEveryMs: 5 },
      async (monitored) => {
        await new Promise<void>((resolve) =>
          monitored.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "failed", outputText: "", failureMessage: "cancelled", retryable: false };
      },
    );
    expect(result.status).toBe("failed");
    expect(result.retryable).toBeUndefined();
    expect(result.failureMessage).toMatch(/no progress/);
  });

  it("leaves a turn that keeps working alone", async () => {
    const result = await runWithProgressCheck(input, { idleMs: 60_000 }, async () => ({
      status: "succeeded",
      outputText: "done",
    }));
    expect(result).toEqual({ status: "succeeded", outputText: "done" });
  });
});
