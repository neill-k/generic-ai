import { describe, expect, it } from "vitest";

import { createMemoryStorage } from "@generic-ai/plugin-storage-memory";

import { createMessagingService, kind, name } from "../src/index.js";

describe("@generic-ai/plugin-messaging", () => {
  it("persists threaded messages in a storage-backed inbox", () => {
    const storage = createMemoryStorage();
    const messaging = createMessagingService({
      storage,
      now: (() => {
        let timestamp = 1000;
        return () => ++timestamp;
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `message-${++counter}`;
      })(),
    });

    const first = messaging.send({
      from: "coordinator",
      to: "implementer",
      body: "Summarize the stack",
      subject: "Starter stack",
    });
    const second = messaging.send({
      from: "implementer",
      to: "coordinator",
      body: "Working on it",
      threadId: first.threadId,
    });

    expect(messaging.name).toBe(name);
    expect(messaging.kind).toBe(kind);
    expect(messaging.thread(first.threadId)).toEqual([first, second]);
    expect(messaging.inbox("implementer")).toEqual([first]);

    const read = messaging.markRead(first.id);
    expect(read?.readAt).toBeDefined();
    expect(messaging.inbox("implementer", { unreadOnly: true })).toEqual([]);

    const rehydrated = createMessagingService({ storage });
    expect(rehydrated.thread(first.threadId)).toHaveLength(2);
    expect(rehydrated.search("coordinator", "stack")).toHaveLength(1);
  });
});
