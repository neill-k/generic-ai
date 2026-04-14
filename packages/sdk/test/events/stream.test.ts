import { describe, expect, it } from "vitest";

import {
  createCanonicalEventStream,
  createDelegationLifecycleEvent,
  createRunLifecycleEvent,
} from "../../src/events/index.js";

describe("sdk canonical event stream", () => {
  it("replays history to late subscribers and preserves sequence order", async () => {
    const stream = createCanonicalEventStream({
      createEventId: () => `evt-${Math.random().toString(36).slice(2, 8)}`,
      now: () => "2026-04-13T00:00:00.000Z",
    });

    const first = await stream.emit(
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
    const subscription = await stream.subscribe((event) => {
      received.push(`${event.sequence}:${event.name}`);
    });

    expect(subscription.closed).toBe(false);
    expect(first.sequence).toBe(1);
    expect(received).toEqual(["1:run.created", "2:delegation.requested"]);

    await stream.emit(
      createRunLifecycleEvent("run.started", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      }),
    );

    expect(received).toEqual(["1:run.created", "2:delegation.requested", "3:run.started"]);
  });

  it("supports filtered subscriptions and unsubscribe", async () => {
    const stream = createCanonicalEventStream();
    const received: string[] = [];

    const subscription = await stream.subscribe(
      (event) => {
        received.push(event.name);
      },
      {
        families: ["delegation"],
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

    expect(received).toEqual(["delegation.completed"]);

    subscription.close();
    expect(subscription.closed).toBe(true);

    await stream.emit(
      createDelegationLifecycleEvent("delegation.cancelled", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
        delegationId: "delegation-1",
      }),
    );

    expect(received).toEqual(["delegation.completed"]);
  });

  it("can snapshot from a given sequence and close the stream", async () => {
    const stream = createCanonicalEventStream({ historyLimit: 2 });

    await stream.emit(
      createRunLifecycleEvent("run.created", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      }),
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
      createRunLifecycleEvent("run.completed", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      }),
    );

    expect(stream.snapshot().map((event) => event.name)).toEqual(["run.started", "run.completed"]);
    expect(stream.snapshot({ fromSequence: 3 }).map((event) => event.name)).toEqual([
      "run.completed",
    ]);

    stream.close();
    expect(stream.closed).toBe(true);
  });
});
