import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  createInMemoryQueue,
  createQueueMemoryPlugin,
} from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

describe("@generic-ai/plugin-queue-memory", () => {
  it("creates a plugin-shaped queue with stable metadata", () => {
    const plugin = createQueueMemoryPlugin(async () => "ok");

    expect(plugin.name).toBe("@generic-ai/plugin-queue-memory");
    expect(plugin.kind).toBe("queue");
    expect(plugin.state).toEqual({
      pending: 0,
      running: 0,
      paused: false,
      closed: false,
      concurrency: 1,
    });
  });

  it("runs higher-priority jobs first and preserves FIFO for ties", async () => {
    const seen: string[] = [];
    const blockers = new Map<string, ReturnType<typeof deferred<void>>>();
    const queue = createInMemoryQueue(async (job) => {
      seen.push(job.id);
      const blocker = blockers.get(job.id);
      if (blocker) {
        await blocker.promise;
      }

      return job.payload;
    });

    blockers.set("high-a", deferred<void>());
    blockers.set("high-b", deferred<void>());
    blockers.set("low", deferred<void>());

    const low = queue.enqueue({ id: "low", payload: "low", priority: 0 });
    const highA = queue.enqueue({ id: "high-a", payload: "high-a", priority: 10 });
    const highB = queue.enqueue({ id: "high-b", payload: "high-b", priority: 10 });

    await delay(0);
    expect(seen).toEqual(["high-a"]);

    blockers.get("high-a")?.resolve();
    await delay(0);
    expect(seen).toEqual(["high-a", "high-b"]);

    blockers.get("high-b")?.resolve();
    await delay(0);
    expect(seen).toEqual(["high-a", "high-b", "low"]);

    blockers.get("low")?.resolve();

    await queue.drain();
    await expect(low).resolves.toBe("low");
    await expect(highA).resolves.toBe("high-a");
    await expect(highB).resolves.toBe("high-b");
  });

  it("pauses and resumes scheduled work", async () => {
    const seen: string[] = [];
    const queue = createInMemoryQueue(async (job) => {
      seen.push(job.id);
      return job.payload;
    });

    const work = queue.enqueue({ id: "job-1", payload: "job-1" });
    queue.pause();

    await delay(0);
    expect(seen).toEqual([]);

    queue.resume();
    await expect(work).resolves.toBe("job-1");
    await queue.drain();
    expect(seen).toEqual(["job-1"]);
  });

  it("rejects pending jobs that are aborted before they start", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    const started: string[] = [];
    const queue = createInMemoryQueue(async (job) => {
      started.push(job.id);
      if (job.id === "blocker") {
        await blocker;
      }

      return job.payload;
    });

    const controller = new AbortController();
    const blockerResult = queue.enqueue({ id: "blocker", payload: "blocker" });
    const abortedResult = queue.enqueue({
      id: "aborted",
      payload: "aborted",
      signal: controller.signal,
    });

    const abortedError = abortedResult.catch((error: unknown) => error);
    controller.abort();
    releaseBlocker();

    await expect(blockerResult).resolves.toBe("blocker");
    await expect(abortedError).resolves.toMatchObject({ name: "AbortError" });
    await queue.drain();
    expect(started).toEqual(["blocker"]);
  });

  it("emits lifecycle events through the typed listener API", async () => {
    const seen: string[] = [];
    const queue = createInMemoryQueue(async (job) => job.payload);
    const onCompleted = (job: { id: string }, result: string) => {
      seen.push(`${job.id}:${result}`);
    };

    queue.on("completed", onCompleted);

    await expect(
      queue.enqueue({ id: "job-1", payload: "ok" }),
    ).resolves.toBe("ok");
    await queue.drain();

    queue.off("completed", onCompleted);
    expect(seen).toEqual(["job-1:ok"]);
  });
});
