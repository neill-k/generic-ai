import { describe, expect, it } from "vitest";

import { SessionOrchestrator } from "../../src/session/index.js";

describe("SessionOrchestrator", () => {
  it("links root and child sessions and keeps child visibility from both sides", () => {
    const orchestrator = new SessionOrchestrator({
      now: (() => {
        let timestamp = 1000;
        return () => ++timestamp;
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `session-${++counter}`;
      })(),
    });

    const root = orchestrator.createRootSession({
      metadata: { kind: "root" },
    });
    const child = orchestrator.createChildSession(root.id, {
      metadata: { kind: "child" },
    });
    const rootWithChild = orchestrator.getSession(root.id);

    expect(root.id).toBe("session-1");
    expect(root.kind).toBe("root");
    expect(rootWithChild?.childSessionIds).toEqual(["session-2"]);
    expect(rootWithChild?.childSessions).toHaveLength(1);
    expect(rootWithChild?.childSessions[0]?.id).toBe("session-2");

    expect(child.id).toBe("session-2");
    expect(child.kind).toBe("child");
    expect(child.parentSessionId).toBe("session-1");
    expect(child.rootSessionId).toBe("session-1");
    expect(orchestrator.getSession(child.id)?.parentSessionId).toBe("session-1");
  });

  it("collects terminal states across the root session tree after success", () => {
    const orchestrator = new SessionOrchestrator({
      now: (() => {
        let timestamp = 2000;
        return () => ++timestamp;
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `session-${++counter}`;
      })(),
    });

    const root = orchestrator.createRootSession();
    const child = orchestrator.createChildSession(root.id);

    orchestrator.completeSession(child.id, { result: { value: "child-ok" } });
    orchestrator.completeSession(root.id, { result: { value: "root-ok" } });

    expect(orchestrator.getSession(root.id)?.status).toBe("succeeded");
    expect(orchestrator.getSession(child.id)?.status).toBe("succeeded");

    expect(orchestrator.collectTerminalStates(root.id)).toHaveLength(2);
    expect(orchestrator.getSession(root.id)?.terminalStates.map((state) => state.id)).toEqual([
      "session-2",
      "session-1",
    ]);
  });

  it("handles failure and cancellation paths for child and root sessions", () => {
    const orchestrator = new SessionOrchestrator({
      now: (() => {
        let timestamp = 3000;
        return () => ++timestamp;
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `session-${++counter}`;
      })(),
    });

    const root = orchestrator.createRootSession();
    const failedChild = orchestrator.createChildSession(root.id);
    const cancelledChild = orchestrator.createChildSession(root.id);
    const nestedChild = orchestrator.createChildSession(cancelledChild.id);

    orchestrator.failSession(failedChild.id, { error: new Error("boom") });
    orchestrator.cancelSession(cancelledChild.id, { reason: "stop" });

    expect(orchestrator.getSession(failedChild.id)?.status).toBe("failed");
    expect(orchestrator.getSession(failedChild.id)?.terminalState?.error?.message).toBe(
      "boom",
    );

    expect(orchestrator.getSession(cancelledChild.id)?.status).toBe("cancelled");
    expect(orchestrator.getSession(nestedChild.id)?.status).toBe("cancelled");
    expect(orchestrator.getSession(root.id)?.status).toBe("active");

    expect(orchestrator.collectTerminalStates(root.id).map((state) => state.id)).toEqual([
      "session-2",
      "session-4",
      "session-3",
    ]);
  });
});
