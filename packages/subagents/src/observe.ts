// Agent observation, adapted from Prime Agent's `agent_observe` controller
// (PrimeIntellect-ai/prime-agent: crates/pa-daemon/src/agent_messaging/observe.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AgentFamilyRelationship } from "./messaging.js";

/** What an agent is doing right now. */
export type AgentActivity = "model" | "tool" | "busy" | "idle";

export const DEFAULT_RECENT_MESSAGES_LIMIT = 8;
export const MAX_RECENT_MESSAGES_LIMIT = 50;
export const DEFAULT_RECENT_MESSAGES_MAX_CHARS = 800;
export const MIN_RECENT_MESSAGES_MAX_CHARS = 80;
export const MAX_RECENT_MESSAGES_MAX_CHARS = 2000;

/** Live state an agent's session exposes for observation. */
export interface AgentObservation {
  /** The transcript, oldest first. */
  messages(): readonly unknown[];
  activity(): AgentActivity;
}

/** The agent state fields observation reads (an `Agent`'s `state` has them). */
export interface ObservableAgentState {
  readonly isStreaming: boolean;
  readonly messages?: readonly unknown[] | undefined;
  readonly streamingMessage?: unknown;
  readonly pendingToolCalls?: ReadonlySet<string> | undefined;
}

/** Running tools, then a streaming model response, then any other work, then idle. */
export function agentActivity(state: ObservableAgentState): AgentActivity {
  if (!state.isStreaming) return "idle";
  if ((state.pendingToolCalls?.size ?? 0) > 0) return "tool";
  if (state.streamingMessage !== undefined) return "model";
  return "busy";
}

/** One agent of the caller's family (or the caller itself), as observation reports it. */
export interface AgentObserveSummary {
  readonly id: string;
  readonly name: string;
  /** How this agent relates to the caller. Absent on the caller's own row. */
  readonly relationship?: AgentFamilyRelationship;
  readonly depth: number;
  /** `running` while the agent works (or, for a subagent, while its task runs). */
  readonly status: "running" | "idle";
  readonly activity: AgentActivity;
  /** Transcript length, when the session exposes its transcript. */
  readonly messageCount?: number;
  /** Messages delivered to a running turn but not yet read by the model. */
  readonly queuedCount: number;
  readonly inboxCount: number;
  /** A subagent's task status: running, completed, error, or cancelled. */
  readonly taskStatus?: string;
  readonly progressNote?: string;
  readonly runningChildren: number;
  readonly messagingPaused: boolean;
}

export interface AgentObserveListResult {
  readonly current: AgentObserveSummary;
  /** Parent, siblings, and children. */
  readonly agents: AgentObserveSummary[];
}

export interface AgentMessagePreview {
  /** Position in the full transcript. */
  readonly index: number;
  readonly role: string;
  readonly timestamp?: number;
  readonly text: string;
  /** True when `text` was cut at `maxChars`. */
  readonly truncated: boolean;
  /** Names of the tools an assistant message called. */
  readonly toolCalls?: string[];
  /** A custom message's type. */
  readonly customType?: string;
}

export interface AgentRecentMessagesResult {
  readonly agent: AgentObserveSummary;
  readonly messages: AgentMessagePreview[];
  readonly limit: number;
  readonly maxChars: number;
  /** True when older messages exist before the returned window. */
  readonly truncated: boolean;
}

/** Messaging state reported by pause, resume, and status. */
export interface AgentMessagingStatus {
  readonly paused: boolean;
  readonly maxMessageChars: number;
  readonly maxPendingPerSession: number;
}

function checkedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`agent_observe ${field} must be an integer when provided`);
  }
  if (value < min || value > max) {
    throw new Error(`agent_observe ${field} must be between ${min} and ${max}`);
  }
  return value;
}

/** Validate the window: `limit` 1-50 (default 8), `maxChars` 80-2000 (default 800). */
export function normalizeRecentMessagesWindow(input: {
  readonly limit?: unknown;
  readonly maxChars?: unknown;
}): { readonly limit: number; readonly maxChars: number } {
  return {
    limit: checkedInteger(
      input.limit,
      DEFAULT_RECENT_MESSAGES_LIMIT,
      1,
      MAX_RECENT_MESSAGES_LIMIT,
      "limit",
    ),
    maxChars: checkedInteger(
      input.maxChars,
      DEFAULT_RECENT_MESSAGES_MAX_CHARS,
      MIN_RECENT_MESSAGES_MAX_CHARS,
      MAX_RECENT_MESSAGES_MAX_CHARS,
      "max_chars",
    ),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A message's text: string content, or its text and thinking blocks (not tool calls or images), or
 * a summary message's summary.
 */
export function messagePreviewText(message: unknown): string {
  const fields = record(message);
  const content = fields?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const blockFields = record(block);
        const text = blockFields?.["text"] ?? blockFields?.["thinking"];
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  const summary = fields?.["summary"];
  return typeof summary === "string" ? summary : "";
}

function toolCallNames(message: unknown): string[] {
  const content = record(message)?.["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const fields = record(block);
    return fields?.["type"] === "toolCall" && typeof fields["name"] === "string"
      ? [fields["name"]]
      : [];
  });
}

/** Bounded previews of the last `limit` messages, each cut to `maxChars` code points. */
export function recentMessagePreviews(
  messages: readonly unknown[],
  limit: number,
  maxChars: number,
): { readonly messages: AgentMessagePreview[]; readonly truncated: boolean } {
  const start = Math.max(0, messages.length - limit);
  return {
    truncated: start > 0,
    messages: messages.slice(start).map((message, offset) => {
      const fields = record(message);
      const full = [...messagePreviewText(message)];
      const role = fields?.["role"];
      const timestamp = fields?.["timestamp"];
      const tools = toolCallNames(message);
      const customType = fields?.["customType"];
      return {
        index: start + offset,
        role: typeof role === "string" ? role : "",
        ...(typeof timestamp === "number" ? { timestamp } : {}),
        text: full.slice(0, maxChars).join(""),
        truncated: full.length > maxChars,
        ...(tools.length > 0 ? { toolCalls: tools } : {}),
        ...(typeof customType === "string" ? { customType } : {}),
      };
    }),
  };
}
