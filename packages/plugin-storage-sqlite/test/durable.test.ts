import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createQueueWorker } from "@generic-ai/sdk";
import { durableQueueConformanceCases, runStoreConformanceCases } from "@generic-ai/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createSqliteRunStore,
  SqliteQueue,
  SqliteRunStore,
  createSqliteStorage,
} from "../src/index.js";

function tempDatabase(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "gai-sqlite-durable-"));
  return {
    file: path.join(directory, "state.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("sqlite run store conformance", () => {
  for (const testCase of runStoreConformanceCases(async (clock) => {
    const { file, cleanup } = tempDatabase();
    const store = new SqliteRunStore({ path: file, now: clock.now });
    return {
      store,
      reopen: async () => new SqliteRunStore({ path: file, now: clock.now }),
      dispose: async () => {
        await store.close();
        cleanup();
      },
    };
  })) {
    it(testCase.name, testCase.run);
  }
});

describe("sqlite durable queue conformance", () => {
  for (const testCase of durableQueueConformanceCases(async (clock) => {
    const { file, cleanup } = tempDatabase();
    const queue = new SqliteQueue<{ n: number }, { ok: boolean }>({ path: file, now: clock.now });
    return {
      queue,
      reopen: async () => new SqliteQueue({ path: file, now: clock.now }),
      dispose: async () => {
        await queue.close();
        cleanup();
      },
    };
  })) {
    it(testCase.name, testCase.run);
  }
});

describe("sqlite durable storage", () => {
  it("shares a database file with the key-value storage without disturbing it", async () => {
    const { file, cleanup } = tempDatabase();
    try {
      const kv = createSqliteStorage({ path: file });
      kv.namespace("agents").set("ceo", { role: "CEO" });
      const runs = createSqliteRunStore({ path: file });
      const queue = new SqliteQueue({ path: file });
      await queue.enqueue({ name: "task", payload: { ok: true } });
      expect(kv.namespace("agents").get("ceo")).toEqual({ role: "CEO" });
      expect(kv.migrate()).toBe(1);
      expect(await runs.listRuns()).toEqual([]);
      kv.close();
      await runs.close();
      await queue.close();
    } finally {
      cleanup();
    }
  });

  it("drives a worker end to end across two queue handles", async () => {
    const { file, cleanup } = tempDatabase();
    const producer = new SqliteQueue<{ n: number }, number>({ path: file });
    const consumer = new SqliteQueue<{ n: number }, number>({ path: file });
    try {
      for (let n = 1; n <= 10; n += 1) {
        await producer.enqueue({ name: "square", payload: { n } });
      }
      const worker = createQueueWorker(consumer, (job) => job.payload.n ** 2, {
        concurrency: 2,
        pollIntervalMs: 5,
      });
      worker.start();
      const deadline = Date.now() + 5_000;
      while ((await producer.stats()).succeeded < 10 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await worker.stop();
      const done = await producer.list({ state: "succeeded" });
      expect(done.map((job) => job.result)).toEqual([1, 4, 9, 16, 25, 36, 49, 64, 81, 100]);
    } finally {
      await producer.close();
      await consumer.close();
      cleanup();
    }
  });
});

describe("queue worker shutdown", () => {
  it("aborts handlers that outlive the drain timeout and returns the job to the queue", async () => {
    const { file, cleanup } = tempDatabase();
    const queue = new SqliteQueue<{ n: number }, string>({ path: file });
    try {
      await queue.enqueue({ id: "slow", name: "task", payload: { n: 1 } });
      let aborted = false;
      const worker = createQueueWorker(
        queue,
        (_job, context) =>
          new Promise<string>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("stopped"));
            });
          }),
        { pollIntervalMs: 5, drainTimeoutMs: 50 },
      );
      worker.start();
      const deadline = Date.now() + 2_000;
      while ((await queue.get("slow"))?.state !== "leased" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await worker.stop();
      expect(aborted).toBe(true);
      expect(worker.active).toBe(0);
      const job = await queue.get("slow");
      expect(job?.state).toBe("queued");
      expect(job?.lastError).toBe("stopped");
    } finally {
      await queue.close();
      cleanup();
    }
  });
});
