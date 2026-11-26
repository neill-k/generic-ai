// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent,
// crates/pa-core/src/session_engine/agent_messaging.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";

import { codePointLength } from "./text.js";

export const AGENT_MESSAGE_ID_PREFIX = "agentmsg_";
export const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16_384;
export const DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION = 20;

/** How the receiving agent is related to the sender, or the sender to the receiver. */
export type AgentFamilyRelationship = "parent" | "sibling" | "child";

export type AgentMessageDeliveryStatus = "delivered" | "queued";

export function isAgentFamilyRelationship(value: unknown): value is AgentFamilyRelationship {
  return value === "parent" || value === "sibling" || value === "child";
}

/** The relationship seen from the other side: a parent's child sees it as a parent. */
export function inverseRelationship(
  relationship: AgentFamilyRelationship,
): AgentFamilyRelationship {
  return relationship === "parent" ? "child" : relationship === "child" ? "parent" : "sibling";
}

export function createAgentMessageId(): string {
  return `${AGENT_MESSAGE_ID_PREFIX}${randomUUID()}`;
}

export function isAgentMessageId(id: string | undefined): boolean {
  return id?.startsWith(AGENT_MESSAGE_ID_PREFIX) === true;
}

/** Trim a message body and check it is non-empty and within `maxChars`. */
export function normalizeAgentMessage(
  message: string,
  maxChars: number = DEFAULT_AGENT_MESSAGE_MAX_CHARS,
): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error("Agent session message cannot be empty");
  }
  const length = codePointLength(trimmed);
  if (length > maxChars) {
    throw new Error(`Agent session message is too long: ${length} chars exceeds ${maxChars}`);
  }
  return trimmed;
}

/** Trim a direct target and reject the broadcast wildcards `*`, `all` and `broadcast`. */
export function assertDirectAgentMessageTarget(target: string): string {
  const normalized = target.trim();
  if (normalized.length === 0) {
    throw new Error("Agent message target cannot be empty");
  }
  const lower = normalized.toLowerCase();
  if (normalized === "*" || lower === "all" || lower === "broadcast") {
    throw new Error("Broadcast agent messaging is not supported");
  }
  return normalized;
}

/** Refuse a delivery when the target already has `maxPending` undelivered messages. */
export function assertAgentMessageQueueCapacity(
  unfinished: number,
  maxPending: number = DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
): void {
  if (unfinished >= maxPending) {
    throw new Error(
      `Target session has too many pending messages: ${unfinished} unfinished, limit is ${maxPending}`,
    );
  }
}

/**
 * A name placed in a `[agent-message from ...]` header must not contain the characters that delimit
 * the header: runs of whitespace, commas, colons and brackets collapse to one space, and the result
 * is trimmed.
 */
export function sanitizeMessageHeaderValue(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    if (/\s/u.test(char) || char === "," || char === ":" || char === "[" || char === "]") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) {
      out += " ";
    }
    pendingSpace = false;
    out += char;
  }
  return out;
}

export interface AgentMessagePromptPayload {
  readonly message: string;
  readonly senderName: string;
  /** How the sender is related to the receiver. */
  readonly fromRelationship?: AgentFamilyRelationship | undefined;
}

/** The text the receiving agent sees: `[agent-message from child:worker]\n\n<message>`. */
export function createAgentMessagePrompt(payload: AgentMessagePromptPayload): string {
  const sanitized = sanitizeMessageHeaderValue(payload.senderName);
  const sender = sanitized.length === 0 ? "unknown" : sanitized;
  const from =
    payload.fromRelationship === undefined ? sender : `${payload.fromRelationship}:${sender}`;
  return `[agent-message from ${from}]\n\n${payload.message}`;
}

/** One addressable member of an agent's family. */
export interface AgentFamilyMember {
  readonly relationship: AgentFamilyRelationship;
  readonly id: string;
  readonly name?: string | undefined;
  /** Other selectors that address the same member. */
  readonly aliases?: readonly string[] | undefined;
}

/** A member's display name: its name, else its id. */
export function agentFamilyMemberName(member: AgentFamilyMember): string {
  return member.name ?? member.id;
}

function memberMatches(member: AgentFamilyMember, selector: string): boolean {
  return (
    agentFamilyMemberName(member) === selector ||
    member.id === selector ||
    (member.aliases ?? []).includes(selector)
  );
}

/**
 * Pick the one family member a message is addressed to. A parent message takes no name; sibling and
 * child messages need one, which matches a member's name, id, or alias.
 */
export function resolveFamilyMember(
  family: readonly AgentFamilyMember[],
  role: unknown,
  receiverName: unknown,
  operation = "send_agent_message",
): AgentFamilyMember {
  if (!isAgentFamilyRelationship(role)) {
    throw new Error(`${operation} receiver_role must be "parent", "sibling", or "child"`);
  }
  const named = receiverName !== undefined && receiverName !== null;
  if (role === "parent" && named) {
    throw new Error(`${operation} receiver_name must be omitted for parent messages`);
  }
  let selector: string | undefined;
  if (role !== "parent") {
    selector = typeof receiverName === "string" ? receiverName.trim() : undefined;
    if (selector === undefined || selector.length === 0) {
      throw new Error(`${operation} receiver_name is required for sibling and child messages`);
    }
  }
  const rendered = named ? JSON.stringify(receiverName) : "null";
  const matches = family.filter(
    (member) =>
      member.relationship === role &&
      (role === "parent" || (selector !== undefined && memberMatches(member, selector))),
  );
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    return only;
  }
  if (matches.length === 0) {
    throw new Error(
      role === "parent" ? "No parent matches the current agent" : `No ${role} matches ${rendered}`,
    );
  }
  throw new Error(`${role} selector ${rendered} is ambiguous`);
}
