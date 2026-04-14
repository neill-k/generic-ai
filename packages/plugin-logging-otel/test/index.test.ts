import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createLoggingOtelPlugin, kind, name } from "../src/index.js";

describe("@generic-ai/plugin-logging-otel", () => {
  it("records lifecycle events as logs and completed spans", () => {
    let tick = 100;
    const plugin = createLoggingOtelPlugin({
      serviceName: "generic-ai.test",
      clock: () => tick,
    });

    plugin.record({
      type: "session.started",
      sessionId: "session-1",
      message: "session started",
    });

    tick = 125;

    const completion = plugin.record({
      type: "session.completed",
      sessionId: "session-1",
      message: "session complete",
      durationMs: 25,
    });

    const snapshot = plugin.snapshot();

    expect(plugin.name).toBe(name);
    expect(plugin.kind).toBe(kind);
    expect(snapshot.logs).toHaveLength(2);
    expect(snapshot.spans).toHaveLength(1);
    expect(completion.span).toMatchObject({
      name: "session",
      status: "ok",
      durationMs: 25,
    });
    expect(snapshot.spans[0]).toMatchObject({
      name: "session",
      status: "ok",
      durationMs: 25,
    });
  });

  it("instruments iterable sources and marks failures as error spans", async () => {
    const plugin = createLoggingOtelPlugin({
      serviceName: "generic-ai.test",
    });

    const subscription = plugin.instrument([
      {
        type: "delegation.started",
        delegationId: "delegation-1",
        message: "delegation started",
      },
      {
        type: "delegation.failed",
        delegationId: "delegation-1",
        message: "delegation failed",
        error: new Error("boom"),
      },
    ]);

    await subscription.done;

    const snapshot = plugin.snapshot();
    expect(snapshot.logs).toHaveLength(2);
    expect(snapshot.spans).toHaveLength(1);
    expect(snapshot.spans[0]).toMatchObject({
      name: "delegation",
      status: "error",
    });

    plugin.clear();
    expect(plugin.snapshot().logs).toEqual([]);
    expect(plugin.snapshot().spans).toEqual([]);
  });

  it("caps retained logs and spans to bound memory usage", () => {
    let tick = 1;
    const plugin = createLoggingOtelPlugin({
      serviceName: "generic-ai.test",
      clock: () => tick++,
      maxBufferedRecords: 2,
    });

    for (const runId of ["run-1", "run-2", "run-3"]) {
      plugin.record({
        type: "run.started",
        runId,
        message: `start ${runId}`,
      });
      plugin.record({
        type: "run.completed",
        runId,
        message: `done ${runId}`,
        durationMs: 1,
      });
    }

    const snapshot = plugin.snapshot();
    expect(snapshot.logs.map((record) => record.body)).toEqual([
      "start run-3",
      "done run-3",
    ]);
    expect(snapshot.spans.map((record) => record.startTime)).toEqual([3, 5]);
    expect(snapshot.spans.map((record) => record.endTime)).toEqual([4, 6]);
  });

  it("stops async iterable instrumentation promptly", async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    async function* source() {
      yield {
        type: "run.started",
        runId: "run-1",
        message: "start run-1",
      };
      await block;
      yield {
        type: "run.completed",
        runId: "run-1",
        message: "done run-1",
        durationMs: 1,
      };
    }

    const plugin = createLoggingOtelPlugin({
      serviceName: "generic-ai.test",
    });
    const subscription = plugin.instrument(source());
    let cleanupSettled = false;
    void subscription.cleanup.then(() => {
      cleanupSettled = true;
    });

    await delay(0);
    subscription.stop();
    await expect(subscription.done).resolves.toBeUndefined();
    expect(plugin.snapshot().logs).toHaveLength(1);
    expect(cleanupSettled).toBe(false);

    release();
    await subscription.cleanup;
    expect(plugin.snapshot().logs).toHaveLength(1);
  });
});
