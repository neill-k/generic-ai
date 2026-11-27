import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  startScriptedServer,
  startThread,
  tempDataDir,
  threadReply,
  waitForReply,
} from "./harness.js";

// A crash mid-run: the server process is killed (SIGKILL, no shutdown hooks) while the VP's turn
// is in flight. A new process over the same data directory must pick the cascade up once the
// dead worker's lease lapses, finish the VP's turn, resume the CEO, and answer the owner, with
// the work done once.

test("a process killed mid-turn resumes the cascade after restart", async ({ page }) => {
  const data = tempDataDir();
  const hangFile = path.join(data.dir, "vp-turn-started");
  const leaseMs = 2_000;
  const env = { E2E_HANG_FILE: hangFile, GENERIC_CORP_TURN_LEASE_MS: String(leaseMs) };
  try {
    const first = await startScriptedServer({ dataDir: data.dir, env });
    const threadId = await startThread(first.url, "Please delegate the chair count.");

    // Wait until the VP's turn has started, then pull the plug.
    await expect.poll(() => existsSync(hangFile), { timeout: 20_000 }).toBe(true);
    expect(readFileSync(hangFile, "utf8")).toBe(String(first.process.pid));
    const before = await threadReply(first.url, threadId);
    expect(before.status).not.toBe("succeeded");
    await first.kill();
    expect(first.process.signalCode).toBe("SIGKILL");

    // Same data directory, new process. The hang file now exists, so the retried turn finishes.
    const second = await startScriptedServer({ dataDir: data.dir, env });
    try {
      const started = Date.now();
      const reply = await waitForReply(second.url, threadId, 30_000);
      expect(reply.status, second.output()).toBe("succeeded");
      expect(reply.text).toBe("The VP reports: 42 chairs counted.");
      // It waited for the dead worker's lease, not much longer.
      expect(Date.now() - started).toBeLessThan(leaseMs + 15_000);

      // The cascade holds exactly one VP task, done once, and the CEO's task is done.
      const tree = (await (await fetch(`${second.url}/api/tasks`)).json()) as {
        tasks: Array<{ agentId: string; status: string; rootTaskId: string }>;
      };
      const mine = tree.tasks.filter((task) => task.rootTaskId === reply.taskId);
      expect(mine.map((task) => `${task.agentId}:${task.status}`).sort()).toEqual([
        "ceo:succeeded",
        "vp-ops:succeeded",
      ]);

      // And the owner sees the answer in the dashboard of the new process.
      await page.goto(`${second.url}/#/goals/${encodeURIComponent(reply.taskId)}`);
      await expect(page.locator(".messages")).toContainText("The VP reports: 42 chairs counted.");
    } finally {
      await second.stop();
    }
  } finally {
    data.remove();
  }
});
