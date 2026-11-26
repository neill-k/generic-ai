import { describe, expect, it } from "vitest";

import {
  createMemoryToolEffectJournal,
  createToolEffectGuard,
  hasOutwardToolEffect,
  type ToolEffectGuardEvent,
  type ToolEffectJournal,
} from "./effect-journal.js";
import { withAgentHarnessToolEffects } from "./types.js";

function sendTool(outbox: string[], options: { readonly fail?: boolean } = {}) {
  return withAgentHarnessToolEffects(
    {
      name: "send_email",
      async execute(_id: string, params: { to: string; body: string }) {
        if (options.fail === true) {
          throw new Error("mail server said no");
        }
        outbox.push(`${params.to}: ${params.body}`);
        return { content: [{ type: "text", text: `sent to ${params.to}` }], details: {} };
      },
    },
    ["message.send"],
  );
}

describe("tool effect guard", () => {
  it("only journals tools with an outward effect", () => {
    const read = withAgentHarnessToolEffects({ name: "read", execute: async () => "x" }, [
      "fs.read",
    ]);
    const outbox: string[] = [];
    expect(hasOutwardToolEffect(read)).toBe(false);
    expect(hasOutwardToolEffect(sendTool(outbox))).toBe(true);
    const guard = createToolEffectGuard(createMemoryToolEffectJournal());
    expect(guard.wrap(read)).toBe(read);
    expect(guard.wrap(sendTool(outbox))).not.toBe(read);
  });

  it("replays finished calls on a retried attempt instead of sending again", async () => {
    const journal = createMemoryToolEffectJournal("turn-1");
    const outbox: string[] = [];
    const first = createToolEffectGuard(journal).wrap(sendTool(outbox));
    await first.execute("a", { to: "ann", body: "hi" });
    await first.execute("b", { to: "bob", body: "hi" });
    await first.execute("c", { to: "ann", body: "hi" });
    expect(outbox).toHaveLength(3);
    expect(journal.records().map((record) => record.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    // The retried attempt makes the same calls in a different order, then one new one.
    const events: ToolEffectGuardEvent[] = [];
    const second = createToolEffectGuard(journal, {
      onEvent: (event) => {
        events.push(event);
      },
    }).wrap(sendTool(outbox));
    expect(await second.execute("x", { to: "bob", body: "hi" })).toEqual({
      content: [{ type: "text", text: "sent to bob" }],
      details: {},
    });
    await second.execute("y", { to: "ann", body: "hi" });
    await second.execute("z", { to: "ann", body: "hi" });
    expect(outbox).toHaveLength(3);
    await second.execute("w", { to: "ann", body: "hi" });
    expect(outbox).toHaveLength(4);
    expect(events.map((event) => event.type)).toEqual([
      "replayed",
      "replayed",
      "replayed",
      "recorded",
    ]);
  });

  it("replays a recorded failure without running the call again", async () => {
    const journal = createMemoryToolEffectJournal();
    const outbox: string[] = [];
    await expect(
      createToolEffectGuard(journal)
        .wrap(sendTool(outbox, { fail: true }))
        .execute("a", { to: "ann", body: "hi" }),
    ).rejects.toThrow("mail server said no");
    const retry = createToolEffectGuard(journal).wrap(sendTool(outbox));
    await expect(retry.execute("b", { to: "ann", body: "hi" })).rejects.toThrow(
      /mail server said no.*not run again/,
    );
    expect(outbox).toHaveLength(0);
    // Calling it again is a new, deliberate call.
    await retry.execute("c", { to: "ann", body: "hi" });
    expect(outbox).toEqual(["ann: hi"]);
  });

  it("refuses to repeat a call that started but never reported back", async () => {
    const records = createMemoryToolEffectJournal("turn-2");
    // The worker dies after the call starts: the completion is never written.
    const dying: ToolEffectJournal = {
      scopeId: records.scopeId,
      read: records.read,
      write: (record) => (record.status === "started" ? records.write(record) : undefined),
    };
    const outbox: string[] = [];
    await createToolEffectGuard(dying)
      .wrap(sendTool(outbox))
      .execute("a", { to: "ann", body: "invoice" });
    expect(outbox).toHaveLength(1);

    const events: ToolEffectGuardEvent[] = [];
    const retry = createToolEffectGuard(records, {
      onEvent: (event) => {
        events.push(event);
      },
    }).wrap(sendTool(outbox));
    await expect(retry.execute("b", { to: "ann", body: "invoice" })).rejects.toThrow(
      /may already have happened/,
    );
    expect(outbox).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["uncertain"]);
  });
});
