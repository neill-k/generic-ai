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

  it("stamps a configured actor on events that do not carry one", async () => {
    const actor = {
      subjectId: "owner",
      actorType: "human" as const,
      credentialSource: "cookie" as const,
    };
    const stream = createCanonicalEventStream({ actor });
    const base = { runId: "run-1", scopeId: "scope", rootSessionId: "s", sessionId: "s" };
    const stamped = await stream.emit({ ...base, name: "run.started" });
    expect(stamped.actor).toEqual(actor);

    const other = { ...actor, subjectId: "agent", actorType: "agent" as const };
    const explicit = await stream.emit({ ...base, name: "run.completed", actor: other });
    expect(explicit.actor).toEqual(other);

    const plain = await createCanonicalEventStream().emit({ ...base, name: "run.started" });
    expect(plain).not.toHaveProperty("actor");
  });

  it("redacts event data before it is stored or delivered", async () => {
    const stream = createCanonicalEventStream({
      redactData: (data) =>
        JSON.parse(JSON.stringify(data).split("fake-secret-value").join("[REDACTED:X]")),
    });
    const delivered: unknown[] = [];
    await stream.subscribe((event) => {
      delivered.push(event.data);
    });
    await stream.emit(
      createRunLifecycleEvent("run.created", {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
        data: { output: "token fake-secret-value" },
      }),
    );
    expect(JSON.stringify(stream.snapshot())).not.toContain("fake-secret-value");
    expect(delivered).toEqual([{ output: "token [REDACTED:X]" }]);
  });
});
