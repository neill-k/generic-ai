import { describe, expect, it } from "vitest";
import {
  computeQueueBackoffMs,
  isDurableQueueError,
  DurableQueueError,
  isRunStoreError,
  RunStoreError,
  replayRunEvents,
  type CanonicalEvent,
} from "../../src/index.js";
import { sampleCanonicalEvent } from "../../src/testing/index.js";

describe("computeQueueBackoffMs", () => {
  it("grows exponentially and respects the cap", () => {
    const backoff = { baseMs: 100, maxMs: 1_000 };
    expect([1, 2, 3, 4, 5].map((attempt) => computeQueueBackoffMs(backoff, attempt))).toEqual([
      100, 200, 400, 800, 1_000,
    ]);
    expect(computeQueueBackoffMs({ baseMs: 10, maxMs: 1_000, factor: 3 }, 3)).toBe(90);
    expect(computeQueueBackoffMs(backoff, 0)).toBe(100);
  });
});

describe("error guards", () => {
  it("identify queue and run store errors by code", () => {
    expect(isDurableQueueError(new DurableQueueError("LEASE_LOST", "x"), "LEASE_LOST")).toBe(true);
    expect(isDurableQueueError(new DurableQueueError("LEASE_LOST", "x"), "CLOSED")).toBe(false);
    expect(isRunStoreError(new RunStoreError("VERSION_CONFLICT", "x"))).toBe(true);
    expect(isRunStoreError(new Error("x"))).toBe(false);
  });
});

describe("replayRunEvents", () => {
  it("pages through the store in sequence order", async () => {
    const events = [1, 2, 3, 4, 5].map((sequence) => sampleCanonicalEvent("run", sequence));
    const reads: Array<{ fromSequence?: number; limit?: number }> = [];
    const store = {
      readEvents: async (
        _runId: string,
        options: { fromSequence?: number; limit?: number } = {},
      ) => {
        reads.push(options);
        return events
          .filter((event) => event.sequence >= (options.fromSequence ?? 0))
          .slice(0, options.limit);
      },
    };
    const seen: CanonicalEvent[] = [];
    const count = await replayRunEvents(
      store,
      "run",
      (event) => {
        seen.push(event);
      },
      { batchSize: 2, fromSequence: 2 },
    );
    expect(count).toBe(4);
    expect(seen.map((event) => event.sequence)).toEqual([2, 3, 4, 5]);
    expect(reads).toEqual([
      { fromSequence: 2, limit: 2 },
      { fromSequence: 4, limit: 2 },
      { fromSequence: 6, limit: 2 },
    ]);
    await expect(replayRunEvents(store, "run", () => {}, { batchSize: 0 })).rejects.toThrow(
      /batchSize/,
    );
  });
});
