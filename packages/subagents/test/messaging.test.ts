// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent,
// crates/pa-core/src/session_engine/agent_messaging/tests.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";

import {
  type AgentFamilyMember,
  assertAgentMessageQueueCapacity,
  assertDirectAgentMessageTarget,
  createAgentMessageId,
  createAgentMessagePrompt,
  DEFAULT_AGENT_MESSAGE_MAX_CHARS,
  inverseRelationship,
  isAgentMessageId,
  normalizeAgentMessage,
  resolveFamilyMember,
  sanitizeMessageHeaderValue,
} from "../src/index.js";

describe("agent messaging", () => {
  it("creates message ids and validates bodies", () => {
    const id = createAgentMessageId();
    expect(id.startsWith("agentmsg_")).toBe(true);
    expect(isAgentMessageId(id)).toBe(true);
    expect(isAgentMessageId("prompt123")).toBe(false);
    expect(isAgentMessageId(undefined)).toBe(false);
    expect(normalizeAgentMessage("  hello  ")).toBe("hello");
    expect(() => normalizeAgentMessage("   ")).toThrow("Agent session message cannot be empty");
    expect(() => normalizeAgentMessage("")).toThrow("Agent session message cannot be empty");
    const long = "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1);
    expect(() => normalizeAgentMessage(long)).toThrow(
      `Agent session message is too long: ${DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1} chars exceeds ${DEFAULT_AGENT_MESSAGE_MAX_CHARS}`,
    );
    expect(normalizeAgentMessage("x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS))).toHaveLength(
      DEFAULT_AGENT_MESSAGE_MAX_CHARS,
    );
    // The limit counts characters, not UTF-16 units.
    expect(normalizeAgentMessage("\u{1F600}".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS))).toBeTruthy();
  });

  it("guards targets and queue capacity", () => {
    expect(assertDirectAgentMessageTarget(" worker ")).toBe("worker");
    expect(() => assertDirectAgentMessageTarget("")).toThrow(
      "Agent message target cannot be empty",
    );
    for (const broadcast of ["*", "all", "All", "BROADCAST"]) {
      expect(() => assertDirectAgentMessageTarget(broadcast)).toThrow(
        "Broadcast agent messaging is not supported",
      );
    }
    expect(() => assertAgentMessageQueueCapacity(3, 20)).not.toThrow();
    expect(() => assertAgentMessageQueueCapacity(20, 20)).toThrow(
      "Target session has too many pending messages: 20 unfinished, limit is 20",
    );
  });

  it("renders message prompts with a sanitized sender", () => {
    expect(
      createAgentMessagePrompt({
        message: "keep going",
        senderName: "worker-1",
        fromRelationship: "child",
      }),
    ).toBe("[agent-message from child:worker-1]\n\nkeep going");
    expect(createAgentMessagePrompt({ message: "m", senderName: "bad name!" })).toBe(
      "[agent-message from bad name!]\n\nm",
    );
    expect(createAgentMessagePrompt({ message: "m", senderName: " [:,] " })).toBe(
      "[agent-message from unknown]\n\nm",
    );
    expect(sanitizeMessageHeaderValue("a:b, [c]\n d")).toBe("a b c d");
    expect(inverseRelationship("parent")).toBe("child");
    expect(inverseRelationship("child")).toBe("parent");
    expect(inverseRelationship("sibling")).toBe("sibling");
  });
});

/** A parent, two siblings (one named "scout"), and two children both named "dual". */
const family: AgentFamilyMember[] = [
  { relationship: "parent", id: "parent-1" },
  { relationship: "sibling", id: "sib-1", name: "scout" },
  { relationship: "sibling", id: "sib-2" },
  { relationship: "child", id: "kid-1", name: "dual", aliases: ["sub-kid1", "sess-kid1"] },
  { relationship: "child", id: "kid-2", name: "dual" },
];

describe("resolveFamilyMember", () => {
  it("resolves by role, name, id, and alias", () => {
    expect(resolveFamilyMember(family, "sibling", " scout ").id).toBe("sib-1");
    expect(resolveFamilyMember(family, "sibling", "sib-2").id).toBe("sib-2");
    expect(resolveFamilyMember(family, "parent", undefined).id).toBe("parent-1");
    expect(resolveFamilyMember(family, "child", "sub-kid1").id).toBe("kid-1");
    expect(resolveFamilyMember(family, "child", "sess-kid1").id).toBe("kid-1");
  });

  it("keeps Prime Agent's error strings", () => {
    expect(() => resolveFamilyMember(family, "parent", "p")).toThrow(
      "send_agent_message receiver_name must be omitted for parent messages",
    );
    expect(() => resolveFamilyMember(family, undefined, undefined)).toThrow(
      'send_agent_message receiver_role must be "parent", "sibling", or "child"',
    );
    expect(() => resolveFamilyMember(family, "child", undefined)).toThrow(
      "send_agent_message receiver_name is required for sibling and child messages",
    );
    expect(() => resolveFamilyMember(family, "child", "ghost")).toThrow('No child matches "ghost"');
    expect(() => resolveFamilyMember(family, "child", "dual")).toThrow(
      'child selector "dual" is ambiguous',
    );
    expect(() => resolveFamilyMember([], "parent", undefined)).toThrow(
      "No parent matches the current agent",
    );
  });
});
