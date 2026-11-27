// The session that print and RPC modes drive: an `Agent`, optionally a `SessionManager`, and the
// host's own hooks for running a prompt, resolving models and compacting.

import type { Agent, AgentMessage, AgentThinkingLevel } from "@generic-ai/agent";
import type { AssistantMessage, ImageContent, Model } from "@generic-ai/ai";

import { type AutoCompactionOptions, persistAgentMessages } from "../agent-session.js";
import type { SessionManager } from "../session-manager.js";

export interface AgentModeHost {
  readonly agent: Agent;
  /** Where messages, model and thinking changes are recorded. */
  readonly sessionManager?: SessionManager | undefined;
  /**
   * Save each finished message to `sessionManager`. Defaults to true; turn it off when the host
   * already persists them.
   */
  readonly persist?: boolean | undefined;
  /**
   * Run one prompt through the host's pipeline (extensions, retry, compaction). Defaults to
   * `agent.prompt`.
   */
  readonly prompt?: ((text: string, images?: ImageContent[]) => Promise<void>) | undefined;
  /** Look up a model for `set_model`. Defaults to `resolveModel` from `@generic-ai/ai`. */
  readonly resolveModel?: ((provider: string, modelId: string) => Model | undefined) | undefined;
  /** Models offered by `get_available_models` and `cycle_model`. Defaults to the current one. */
  readonly availableModels?: (() => readonly Model[]) | undefined;
  /** Settings for `compact` and automatic compaction (the model is the agent's). */
  readonly compaction?: Omit<AutoCompactionOptions, "model"> | undefined;
  /** Commands `get_commands` lists, such as extension commands. */
  readonly commands?: (() => readonly RpcCommandInfo[]) | undefined;
  /** Called when the mode ends. */
  readonly dispose?: (() => Promise<void> | void) | undefined;
}

export interface RpcCommandInfo {
  readonly name: string;
  readonly description?: string;
}

export const THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Start saving messages when the host wants it. Returns the function that stops it. */
export function bindPersistence(host: AgentModeHost): () => void {
  if (host.sessionManager === undefined || host.persist === false) {
    return () => {};
  }
  return persistAgentMessages(host.agent, host.sessionManager);
}

export function runHostPrompt(
  host: AgentModeHost,
  text: string,
  images?: ImageContent[],
): Promise<void> {
  if (host.prompt !== undefined) {
    return host.prompt(text, images);
  }
  return images === undefined ? host.agent.prompt(text) : host.agent.prompt(text, images);
}

export function lastAssistantMessage(
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

/** The text blocks of the last assistant message, or `undefined` when there is none. */
export function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
  const last = lastAssistantMessage(messages);
  if (last === undefined) return undefined;
  return last.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

export interface SessionStats {
  readonly sessionFile: string | undefined;
  readonly sessionId: string | undefined;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
}

export function sessionStats(host: AgentModeHost): SessionStats {
  const messages = host.agent.state.messages;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    if (message.role === "toolResult") toolResults += 1;
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      assistantMessages += 1;
      toolCalls += assistant.content.filter((block) => block.type === "toolCall").length;
      tokens.input += assistant.usage.input;
      tokens.output += assistant.usage.output;
      tokens.cacheRead += assistant.usage.cacheRead;
      tokens.cacheWrite += assistant.usage.cacheWrite;
      tokens.total += assistant.usage.totalTokens;
      cost += assistant.usage.cost.total;
    }
  }
  return {
    sessionFile: host.sessionManager?.getSessionFile(),
    sessionId: host.sessionManager?.getSessionId(),
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: messages.length,
    tokens,
    cost,
  };
}
