import { describe, expect, it } from "vitest";
import {
  createDefaultOutputPlugin,
  defaultOutputPlugin,
  finalizeDefaultOutput,
  kind,
  name,
  renderDefaultOutput,
} from "../src/index.js";

describe("@generic-ai/plugin-output-default", () => {
  it("renders primitive values and finalizes them into a stable record", () => {
    const record = finalizeDefaultOutput("ready", {
      now: () => new Date("2026-04-14T12:00:00.000Z"),
    });

    expect(record).toEqual({
      plugin: name,
      kind,
      status: "completed",
      summary: "ready",
      text: "ready",
      payload: "ready",
      metadata: {},
      producedAt: "2026-04-14T12:00:00.000Z",
    });
  });

  it("keeps object payloads isolated while honoring text-like fields and metadata", () => {
    const payload = {
      text: "final answer",
      status: "cancelled" as const,
      metadata: {
        runId: "run-123",
      },
      nested: {
        count: 1,
      },
    };

    const record = defaultOutputPlugin.finalize(payload);
    payload.nested.count = 2;

    expect(record.plugin).toBe(name);
    expect(record.kind).toBe(kind);
    expect(record.status).toBe("cancelled");
    expect(record.text).toBe("final answer");
    expect(record.summary).toBe("final answer");
    expect(record.metadata).toEqual({ runId: "run-123" });
    expect(record.payload).toEqual({
      text: "final answer",
      status: "cancelled",
      metadata: {
        runId: "run-123",
      },
      nested: {
        count: 1,
      },
    });
    expect(record.payload).not.toBe(payload);
  });

  it("turns errors into failed output with a predictable text form", () => {
    const record = finalizeDefaultOutput(new Error("boom"));

    expect(record.status).toBe("failed");
    expect(record.text).toBe("Error: boom");
    expect(record.summary).toBe("Error: boom");
  });

  it("allows custom renderers and summary truncation for replacement plugins", () => {
    const plugin = createDefaultOutputPlugin({
      render: () => "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4),
      summaryLength: 32,
      now: () => "2026-04-14T12:30:00.000Z",
    });

    const record = plugin.finalize({ ok: true });

    expect(record.text).toBe("abcdefghijklmnopqrstuvwxyz0123456789".repeat(4));
    expect(record.summary).toBe("abcdefghijklmnopqrstuvwxyz012...");
    expect(record.producedAt).toBe("2026-04-14T12:30:00.000Z");
    expect(renderDefaultOutput("hello")).toBe("hello");
  });
});
