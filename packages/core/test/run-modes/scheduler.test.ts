import { describe, expect, it } from "vitest";
import { createImmediateScheduler } from "../../src/scheduler/immediate-scheduler.js";
import { createManualScheduler } from "../../src/scheduler/manual-scheduler.js";

describe("schedulers", () => {
  it("runs immediate tasks inline", () => {
    const scheduler = createImmediateScheduler();
    const events: string[] = [];

    scheduler.schedule(() => {
      events.push("ran");
    });

    expect(events).toEqual(["ran"]);
  });

  it("queues manual tasks until flushed", async () => {
    const scheduler = createManualScheduler();
    const events: string[] = [];

    const first = scheduler.schedule(() => {
      events.push("first");
    });
    const second = scheduler.schedule(() => {
      events.push("second");
    });

    second.cancel();

    expect(scheduler.pendingCount).toBe(1);

    await scheduler.flushAll();

    expect(events).toEqual(["first"]);
    expect(first.cancelled).toBe(false);
    expect(second.cancelled).toBe(true);
  });
});
