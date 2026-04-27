import { describe, expect, it } from "vitest";

import {
  canonicalCoreEventNames,
  canonicalDelegationLifecycleNames,
  canonicalArtifactLifecycleNames,
  canonicalHandoffLifecycleNames,
  canonicalPolicyLifecycleNames,
  canonicalRunLifecycleNames,
  canonicalSessionLifecycleNames,
  canonicalTerminalCommandLifecycleNames,
  canonicalToolCallLifecycleNames,
  createCanonicalEvent,
  createPluginEvent,
  getCanonicalEventFamily,
  isCanonicalCoreEventName,
  isCanonicalEventName,
  isCanonicalPluginEventName,
} from "../../src/events/index.js";

describe("core canonical event taxonomy", () => {
  it("keeps the kernel taxonomy aligned with the SDK contract", () => {
    expect(canonicalRunLifecycleNames).toEqual([
      "run.created",
      "run.started",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ]);
    expect(canonicalSessionLifecycleNames).toContain("session.child.completed");
    expect(canonicalDelegationLifecycleNames).toContain("delegation.accepted");
    expect(canonicalHandoffLifecycleNames).toContain("handoff.completed");
    expect(canonicalToolCallLifecycleNames).toContain("tool.call.started");
    expect(canonicalTerminalCommandLifecycleNames).toContain("terminal.command.failed");
    expect(canonicalPolicyLifecycleNames).toEqual(["policy.decision"]);
    expect(canonicalArtifactLifecycleNames).toEqual(["artifact.created"]);
    expect(canonicalCoreEventNames).toHaveLength(
      canonicalRunLifecycleNames.length +
        canonicalSessionLifecycleNames.length +
        canonicalDelegationLifecycleNames.length +
        canonicalHandoffLifecycleNames.length +
        canonicalToolCallLifecycleNames.length +
        canonicalTerminalCommandLifecycleNames.length +
        canonicalPolicyLifecycleNames.length +
        canonicalArtifactLifecycleNames.length,
    );
  });

  it("recognizes canonical names and plugin extensions", () => {
    expect(isCanonicalCoreEventName("run.created")).toBe(true);
    expect(isCanonicalCoreEventName("policy.decision")).toBe(true);
    expect(isCanonicalCoreEventName("artifact.created")).toBe(true);
    expect(isCanonicalPluginEventName("plugin.otel.trace.started")).toBe(true);
    expect(isCanonicalEventName("session.child.created")).toBe(true);
    expect(isCanonicalEventName("plugin.otel.trace.started")).toBe(true);
    expect(isCanonicalEventName("something-else")).toBe(false);
    expect(getCanonicalEventFamily("delegation.completed")).toBe("delegation");
    expect(getCanonicalEventFamily("handoff.completed")).toBe("handoff");
    expect(getCanonicalEventFamily("tool.call.failed")).toBe("tool");
  });

  it("seals kernel events with stable runtime metadata", () => {
    const event = createCanonicalEvent({
      name: "session.started",
      scopeId: "scope-1",
      runId: "run-1",
      rootSessionId: "session-root",
      sessionId: "session-1",
      parentSessionId: "session-root",
      data: {
        agentId: "agent-1",
      },
    });

    expect(event.name).toBe("session.started");
    expect(Object.isFrozen(event)).toBe(true);
    expect(event.data).toEqual({ agentId: "agent-1" });
  });

  it("creates plugin events with plugin metadata", () => {
    const event = createPluginEvent(
      "logging-otel",
      "run.exported",
      {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
      },
      {
        createEventId: () => "evt-core-123",
        now: () => "2026-04-13T00:00:00.000Z",
      },
    );

    expect(event.name).toBe("plugin.logging-otel.run.exported");
    expect(event.eventId).toBe("evt-core-123");
    expect(event.origin.namespace).toBe("plugin");
  });
});
