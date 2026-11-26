import { describe, expect, it } from "vitest";

import { AgentIsolationError, describeAgentIsolation, resolveAgentIsolation } from "./isolation.js";

describe("agent isolation", () => {
  const ok = () => undefined;
  const denied = () => "sudo: a password is required";

  it("runs agent commands as the configured user when the server can switch to it", () => {
    const isolation = resolveAgentIsolation({ GENERIC_CORP_AGENT_USER: "agent" }, ok);
    expect(isolation).toMatchObject({ mode: "user", user: "agent", runAs: { user: "agent" } });
    expect(describeAgentIsolation(isolation)).toContain('"agent"');
  });

  it("falls back to the server's user with a reason, or refuses to start when required", () => {
    const fallback = resolveAgentIsolation({ GENERIC_CORP_AGENT_USER: "agent" }, denied);
    expect(fallback).toMatchObject({ mode: "shared" });
    expect(fallback.runAs).toBeUndefined();
    expect(describeAgentIsolation(fallback)).toMatch(/^WARNING: .*password is required/);

    expect(() =>
      resolveAgentIsolation(
        { GENERIC_CORP_AGENT_USER: "agent", GENERIC_CORP_AGENT_ISOLATION: "required" },
        denied,
      ),
    ).toThrow(AgentIsolationError);
    expect(() => resolveAgentIsolation({ GENERIC_CORP_AGENT_ISOLATION: "required" }, ok)).toThrow(
      /GENERIC_CORP_AGENT_USER is not set/,
    );
  });

  it("can be turned off, and rejects bad values", () => {
    expect(
      resolveAgentIsolation(
        { GENERIC_CORP_AGENT_USER: "agent", GENERIC_CORP_AGENT_ISOLATION: "off" },
        ok,
      ).mode,
    ).toBe("shared");
    expect(resolveAgentIsolation({}, ok).mode).toBe("shared");
    expect(() => resolveAgentIsolation({ GENERIC_CORP_AGENT_ISOLATION: "maybe" }, ok)).toThrow(
      AgentIsolationError,
    );
    expect(() => resolveAgentIsolation({ GENERIC_CORP_AGENT_USER: "agent; rm -rf /" }, ok)).toThrow(
      AgentIsolationError,
    );
  });
});
