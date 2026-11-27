// Turn-level resume: decide where a saved session stopped and get the agent ready to carry on from
// its last completed step. Every finished message is already appended to the session file as it
// ends (`persistAgentMessages`), so after a crash the file holds each completed step; this module
// works out what, if anything, is left to do.

import type { Agent, AgentMessage } from "@generic-ai/agent";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@generic-ai/ai";

import { restoreAgentContext } from "./agent-session.js";
import type { SessionManager } from "./session-manager.js";

export type ResumePoint =
  /** Nothing has been said yet. */
  | { readonly kind: "empty" }
  /** The last step is a finished answer with no tool calls waiting: nothing is left to do. */
  | { readonly kind: "complete"; readonly message: AssistantMessage }
  /**
   * The model owes the next step: the session ends in a user message or tool results, or (once
   * prepared) in a failed response that was set aside or tool calls that were cut off.
   */
  | {
      readonly kind: "continue";
      readonly reason: "user-message" | "tool-results" | "interrupted-tools" | "failed-response";
    };

export const INTERRUPTED_TOOL_TEXT =
  "This tool call was interrupted by a restart before it finished, so its result was lost. Check whether it took effect before running it again.";

function isAssistant(message: AgentMessage | undefined): message is AssistantMessage {
  return message !== undefined && (message as { role?: unknown }).role === "assistant";
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** The tool calls of the last assistant message that have no result after it. */
export function pendingToolCalls(messages: readonly AgentMessage[]): ToolCall[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistant(message)) continue;
    const answered = new Set(
      messages
        .slice(index + 1)
        .filter(
          (entry): entry is ToolResultMessage =>
            (entry as { role?: unknown }).role === "toolResult",
        )
        .map((entry) => entry.toolCallId),
    );
    return toolCallsOf(message).filter((call) => !answered.has(call.id));
  }
  return [];
}

/** Where a conversation stopped, without changing anything. */
export function findResumePoint(messages: readonly AgentMessage[]): ResumePoint {
  const last = messages.at(-1);
  if (last === undefined) return { kind: "empty" };
  if (isAssistant(last)) {
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      return { kind: "continue", reason: "failed-response" };
    }
    if (toolCallsOf(last).length > 0) return { kind: "continue", reason: "interrupted-tools" };
    return { kind: "complete", message: last };
  }
  if ((last as { role?: unknown }).role === "toolResult") {
    return pendingToolCalls(messages).length > 0
      ? { kind: "continue", reason: "interrupted-tools" }
      : { kind: "continue", reason: "tool-results" };
  }
  return { kind: "continue", reason: "user-message" };
}

/** The id of the session entry holding the branch's last message. */
function lastMessageEntryId(manager: SessionManager): string | undefined {
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message") return entry.id;
  }
  return undefined;
}

/**
 * Load the session into the agent and make it ready to continue from its last completed step:
 *
 * - a failed or aborted last response is set aside (the session branches from the entry before it,
 *   so the file keeps it but the context no longer does) and the step is tried again;
 * - tool calls cut off before their results were saved get an error result saying so, rather than
 *   being run a second time, since a tool may already have taken effect;
 * - a session ending in a user message or tool results is left as it is.
 *
 * Returns where the session stands afterwards. For `continue`, call `agent.continue()`.
 */
export function prepareSessionResume(
  agent: Agent,
  manager: SessionManager,
  options: { readonly interruptedToolText?: string } = {},
): ResumePoint {
  restoreAgentContext(agent, manager);
  let point = findResumePoint(agent.state.messages);
  let setAside = false;
  while (point.kind === "continue" && point.reason === "failed-response") {
    const failedId = lastMessageEntryId(manager);
    const failed = failedId === undefined ? undefined : manager.getEntry(failedId);
    if (failed === undefined) break;
    if (failed.parentId === null) manager.resetLeaf();
    else manager.branch(failed.parentId);
    restoreAgentContext(agent, manager);
    setAside = true;
    point = findResumePoint(agent.state.messages);
  }
  if (point.kind === "continue" && point.reason === "interrupted-tools") {
    const text = options.interruptedToolText ?? INTERRUPTED_TOOL_TEXT;
    for (const call of pendingToolCalls(agent.state.messages)) {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        details: { interrupted: true },
        isError: true,
        timestamp: Date.now(),
      };
      manager.appendMessage(result);
      agent.state.messages = [...agent.state.messages, result];
    }
    return point;
  }
  if (setAside && point.kind !== "empty") {
    return point.kind === "complete" ? point : { kind: "continue", reason: "failed-response" };
  }
  return point;
}
