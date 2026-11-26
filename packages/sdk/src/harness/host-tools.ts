import type { Awaitable, JsonObject } from "../contracts/shared.js";
import type { AgentHarnessCapabilityEffect } from "./types.js";

/**
 * A tool the host adds to one harness run, described without any runtime's tool types so it works
 * on every adapter. Core turns it into a native tool for the pi and native runtimes. The delegation
 * cascade uses it for `delegate_task` and `finish_task` (ADR 0062).
 */
export interface AgentHarnessHostTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  /** One line for the system prompt's tool list. */
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  /** JSON Schema for the arguments (an object schema). */
  readonly parameters: JsonObject;
  /** Effects for role policy, for example `handoff.write`. */
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  execute(
    params: JsonObject,
    context: AgentHarnessHostToolContext,
  ): Awaitable<AgentHarnessHostToolResult>;
}

export interface AgentHarnessHostToolContext {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}

export interface AgentHarnessHostToolResult {
  /** What the model sees. */
  readonly text: string;
  /** When true the call is reported to the model as a failed tool call. */
  readonly isError?: boolean;
  readonly details?: JsonObject;
}
