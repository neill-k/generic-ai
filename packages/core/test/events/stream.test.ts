import { describe, expect, it } from "vitest";

import {
  createCanonicalEventStream,
  createDelegationLifecycleEvent,
  createRunLifecycleEvent,
} from "../../src/events/index.js";

describe("core canonical event stream", () => {
  it("replays events in order for late subscribers", async () => {
    const stream = createCanonicalEventStream({
      createEventId: () => `evt-${Math.random().toString(36).slice(2, 8)}`,
      now: () => "2026-04-13T00:00:00.000Z",
    });

    await stream.emit(
      createRunLifecycleEvent("run.created", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      }),
    );
    await stream.emit(
      createDelegationLifecycleEvent("delegation.requested", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
        delegationId: "delegation-1",
      }),
    );

    const received: string[] = [];
    await stream.subscribe((event) => {
      received.push(`${event.sequence}:${event.name}`);
    });

    expect(received).toEqual(["1:run.created", "2:delegation.requested"]);
  });

  it("filters subscriptions and closes cleanly", async () => {
    const stream = createCanonicalEventStream();
    const received: string[] = [];

    const subscription = await stream.subscribe(
      (event) => {
        received.push(event.name);
      },
      {
        namespaces: ["plugin"],
      },
    );

    await stream.emit(
      createRunLifecycleEvent("run.started", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      }),
    );
    await stream.emit(
      createDelegationLifecycleEvent("delegation.completed", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
        delegationId: "delegation-1",
      }),
    );

    expect(received).toEqual([]);

    subscription.close();
    expect(subscription.closed).toBe(true);
    stream.close();
    expect(stream.closed).toBe(true);
  });
});
