import { describe, expect, it } from "vitest";

import { Inbox } from "../src/index.js";

describe("Inbox", () => {
  it("drains matching items and counts the rest", () => {
    let now = 100;
    const inbox = new Inbox({ now: () => now });
    const seen: number[] = [];
    inbox.onItem((item) => seen.push(item.id));
    inbox.push({ kind: "agent-message", sender: "scout", text: "hi" });
    now = 200;
    inbox.push({ kind: "child-exited", sender: "worker", text: "done" });
    now = 300;
    inbox.push({ kind: "child-failed", sender: "worker", text: "boom" });
    expect(seen).toEqual([1, 2, 3]);

    expect(inbox.count()).toEqual({
      count: 3,
      oldestAt: 100,
      byKind: { "agent-message": 1, "child-exited": 1, "child-failed": 1 },
    });
    expect(inbox.peek({ sender: "worker" }).map((item) => item.text)).toEqual(["done", "boom"]);
    expect(inbox.read({ sinceMs: 200, beforeMs: 300 }).map((item) => item.text)).toEqual(["done"]);
    expect(inbox.read({ kind: "agent-message" }).map((item) => item.sender)).toEqual(["scout"]);
    expect(inbox.count().count).toBe(1);
    expect(inbox.read().map((item) => item.text)).toEqual(["boom"]);
    expect(inbox.count()).toEqual({
      count: 0,
      byKind: { "agent-message": 0, "child-exited": 0, "child-failed": 0 },
    });
  });
});
