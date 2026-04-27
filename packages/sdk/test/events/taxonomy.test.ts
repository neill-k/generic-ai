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

describe("sdk canonical event taxonomy", () => {
  it("groups the canonical lifecycle names into stable families", () => {
    expect(canonicalRunLifecycleNames).toEqual([
      "run.created",
      "run.started",
      "run.completed",
      "run.failed",
      "run.cancelled",
    ]);
    expect(canonicalSessionLifecycleNames).toContain("session.child.started");
    expect(canonicalDelegationLifecycleNames).toContain("delegation.rejected");
    expect(canonicalHandoffLifecycleNames).toContain("handoff.completed");
    expect(canonicalToolCallLifecycleNames).toContain("tool.call.failed");
    expect(canonicalTerminalCommandLifecycleNames).toContain("terminal.command.completed");
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

  it("identifies canonical and plugin event names", () => {
    expect(isCanonicalCoreEventName("run.started")).toBe(true);
    expect(isCanonicalCoreEventName("tool.call.started")).toBe(true);
    expect(isCanonicalCoreEventName("artifact.created")).toBe(true);
    expect(isCanonicalPluginEventName("plugin.logging-otel.span.created")).toBe(true);
    expect(isCanonicalEventName("run.started")).toBe(true);
    expect(isCanonicalEventName("plugin.logging-otel.span.created")).toBe(true);
    expect(isCanonicalEventName("not-an-event")).toBe(false);
    expect(getCanonicalEventFamily("session.child.failed")).toBe("session");
    expect(getCanonicalEventFamily("terminal.command.failed")).toBe("terminal");
    expect(getCanonicalEventFamily("policy.decision")).toBe("policy");
    expect(getCanonicalEventFamily("plugin.logging-otel.span.created")).toBe("plugin");
  });

  it("seals canonical events with immutable runtime metadata", () => {
    const event = createCanonicalEvent({
      name: "run.started",
      scopeId: "scope-1",
      runId: "run-1",
      rootSessionId: "session-root",
      sessionId: "session-root",
      data: {
        executionMode: "sync",
      },
    });

    expect(event.name).toBe("run.started");
    expect(event.eventId).toBeTypeOf("string");
    expect(event.sequence).toBe(0);
    expect(event.occurredAt).toBeTypeOf("string");
    expect(Object.isFrozen(event)).toBe(true);
    expect(event.data).toEqual({ executionMode: "sync" });
  });

  it("creates namespaced plugin events with plugin origin metadata", () => {
    const event = createPluginEvent(
      "logging-otel",
      "span.created",
      {
        scopeId: "scope-1",
        runId: "run-1",
        rootSessionId: "session-root",
        sessionId: "session-root",
        data: {
          spanId: "span-1",
        },
      },
      {
        createEventId: () => "evt-123",
        now: () => "2026-04-13T00:00:00.000Z",
      },
    );

    expect(event.name).toBe("plugin.logging-otel.span.created");
    expect(event.eventId).toBe("evt-123");
    expect(event.occurredAt).toBe("2026-04-13T00:00:00.000Z");
    expect(event.origin).toEqual({
      namespace: "plugin",
      pluginId: "logging-otel",
      subsystem: undefined,
    });
    expect(isCanonicalCoreEventName(event.name)).toBe(false);
  });
});
