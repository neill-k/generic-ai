// Agent tools over an agent tree node. The operations and their rules follow Prime Agent's
// `rlm` and `agent_message` kernel surface (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AgentTool, AgentToolResult } from "@generic-ai/agent";
import { Type } from "@sinclair/typebox";

import { INBOX_KINDS, type InboxKind } from "./inbox.js";
import type { AgentNode } from "./supervisor.js";

export const SPAWN_AGENT_TOOL = "spawn_agent";
export const COLLECT_AGENTS_TOOL = "collect_agents";
export const LIST_AGENTS_TOOL = "list_agents";
export const DELETE_AGENT_TOOL = "delete_agent";
export const RENAME_AGENT_TOOL = "rename_agent";
export const SEND_AGENT_MESSAGE_TOOL = "send_agent_message";
export const READ_INBOX_TOOL = "read_inbox";
export const PROGRESS_NOTE_TOOL = "progress_note";
export const OBSERVE_AGENTS_TOOL = "observe_agents";
export const GET_AGENT_TOOL = "get_agent";
export const RECENT_AGENT_MESSAGES_TOOL = "recent_agent_messages";

export interface SubagentToolsOptions {
  /** Include spawn, collect, list, rename, and delete. Defaults to true when the node may spawn. */
  readonly spawning?: boolean | undefined;
  /** Include `send_agent_message`. Defaults to true. */
  readonly messaging?: boolean | undefined;
  /** Include `read_inbox`. Defaults to true. */
  readonly inbox?: boolean | undefined;
  /** Include `progress_note`. Defaults to true for subagents and false for the root. */
  readonly progress?: boolean | undefined;
  /** Include `observe_agents`, `get_agent`, and `recent_agent_messages`. Defaults to true. */
  readonly observe?: boolean | undefined;
}

function result<T>(value: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

const spawnSchema = Type.Object({
  prompt: Type.String({ description: "The task for the subagent, with all the context it needs." }),
  name: Type.Optional(
    Type.String({
      description:
        "Short unique name used to address the subagent (at most 64 characters). Defaults to agent-N.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model for the subagent. Defaults to yours." })),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level: off, minimal, low, medium, high, or xhigh." }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent." })),
});

const collectSchema = Type.Object({
  targets: Type.Optional(
    Type.Array(Type.String(), {
      description: "Names or ids of the subagents to collect. Omit to collect all of them.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "How long to wait for running subagents to finish. 0 (the default) returns their state at once.",
    }),
  ),
});

const targetSchema = Type.Object({
  target: Type.String({ description: "Name or id of the subagent." }),
});

const renameSchema = Type.Object({
  target: Type.String({ description: "Name or id of the subagent." }),
  name: Type.String({ description: "The new name." }),
});

const sendSchema = Type.Object({
  message: Type.String({ description: "The message (at most 16,384 characters)." }),
  receiver_role: Type.Union(
    [Type.Literal("parent"), Type.Literal("sibling"), Type.Literal("child"), Type.Literal("all")],
    { description: 'Who receives it: your "parent", a "sibling", a "child", or "all" of them.' },
  ),
  receiver_name: Type.Optional(
    Type.String({ description: "Name or id of the sibling or child. Omit for parent and all." }),
  ),
});

const inboxSchema = Type.Object({
  sender: Type.Optional(Type.String({ description: "Only items from this agent name." })),
  kind: Type.Optional(
    Type.Union(
      INBOX_KINDS.map((kind) => Type.Literal(kind)),
      { description: "Only items of this kind." },
    ),
  ),
  since_ms: Type.Optional(
    Type.Number({ description: "Only items received at or after this time." }),
  ),
  before_ms: Type.Optional(Type.Number({ description: "Only items received before this time." })),
  peek: Type.Optional(Type.Boolean({ description: "Return the items without removing them." })),
});

const observeTargetSchema = Type.Object({
  target: Type.String({ description: "Id or name of a parent, sibling, or child agent." }),
});

const recentMessagesSchema = Type.Object({
  target: Type.String({ description: "Id or name of a parent, sibling, or child agent." }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "Messages to show, 1-50. Default 8." }),
  ),
  max_chars: Type.Optional(
    Type.Integer({
      minimum: 80,
      maximum: 2000,
      description: "Characters kept per message, 80-2000. Default 800.",
    }),
  ),
});

const noteSchema = Type.Object({
  message: Type.String({ description: "One line on where you are (at most 512 characters)." }),
});

/** An agent tool with the optional system-prompt snippet and guidelines the native runtime reads. */
// biome-ignore lint/suspicious/noExplicitAny: tools carry their own parameter and detail types.
export type SubagentTool = AgentTool<any, any> & {
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

/** The subagent and messaging tools for one agent of a tree. */
export function createSubagentTools(
  node: AgentNode,
  options: SubagentToolsOptions = {},
): SubagentTool[] {
  const tools: SubagentTool[] = [];
  if (options.spawning ?? node.canSpawn) {
    tools.push(
      {
        name: SPAWN_AGENT_TOOL,
        label: "Spawn agent",
        description:
          "Start a subagent on a task. It runs in the background; use collect_agents to wait for its answer.",
        promptSnippet: "start a subagent on a task that runs in the background",
        promptGuidelines: [
          "Give each subagent a self-contained task; it does not see your conversation.",
          "Call collect_agents with a timeout to wait for subagents instead of polling.",
        ],
        parameters: spawnSchema,
        execute: async (_id, params) => result(await node.children.spawn(params)),
      },
      {
        name: COLLECT_AGENTS_TOOL,
        label: "Collect agents",
        description:
          "Get the status and answers of subagents, optionally waiting up to timeout_ms for running ones to finish.",
        parameters: collectSchema,
        execute: async (_id, params, signal) =>
          result({
            results: await node.children.collect(params.targets ?? [], params.timeout_ms, signal),
          }),
      },
      {
        name: LIST_AGENTS_TOOL,
        label: "List agents",
        description:
          "List your subagents with their status, task, progress note, and answer preview.",
        parameters: Type.Object({}),
        execute: async () => result({ agents: node.children.list() }),
      },
      {
        name: DELETE_AGENT_TOOL,
        label: "Delete agent",
        description: "Stop a subagent and its own subagents, and remove it.",
        parameters: targetSchema,
        execute: async (_id, params) => result(await node.children.delete(params.target)),
      },
      {
        name: RENAME_AGENT_TOOL,
        label: "Rename agent",
        description: "Rename a subagent.",
        parameters: renameSchema,
        execute: async (_id, params) =>
          result({ name: node.children.rename(params.target, params.name) }),
      },
    );
  }
  if (options.messaging ?? true) {
    tools.push({
      name: SEND_AGENT_MESSAGE_TOOL,
      label: "Send agent message",
      description:
        "Send a message to your parent agent, a sibling, a child, or all of them. A running agent gets it after its current step; a finished subagent starts work on it.",
      parameters: sendSchema,
      execute: async (_id, params) =>
        params.receiver_role === "all"
          ? result(node.broadcast(params.message))
          : result(
              node.sendMessage({
                message: params.message,
                receiverRole: params.receiver_role,
                receiverName: params.receiver_name,
              }),
            ),
    });
  }
  if (options.inbox ?? true) {
    tools.push({
      name: READ_INBOX_TOOL,
      label: "Read inbox",
      description:
        "Read and remove items from your inbox: messages that arrived while you were idle, and notices of subagents that finished or failed.",
      parameters: inboxSchema,
      execute: async (_id, params) => {
        const filter = {
          sender: params.sender as string | undefined,
          kind: params.kind as InboxKind | undefined,
          sinceMs: params.since_ms as number | undefined,
          beforeMs: params.before_ms as number | undefined,
        };
        return result({
          items: params.peek === true ? node.inbox.peek(filter) : node.inbox.read(filter),
          remaining: node.inbox.count().count,
        });
      },
    });
  }
  if (options.observe ?? true) {
    tools.push(
      {
        name: OBSERVE_AGENTS_TOOL,
        label: "Observe agents",
        description:
          "See your own state and your parent's, siblings' and children's: whether each is running, what it is doing (model, tool, busy, idle), queued messages, inbox size, task status, and progress note.",
        parameters: Type.Object({}),
        execute: async () => result(node.observeAgents()),
      },
      {
        name: GET_AGENT_TOOL,
        label: "Get agent",
        description: "See one parent, sibling, or child agent's current state.",
        parameters: observeTargetSchema,
        execute: async (_id, params) => result({ agent: node.observeAgent(params.target) }),
      },
      {
        name: RECENT_AGENT_MESSAGES_TOOL,
        label: "Recent agent messages",
        description:
          "Read short previews of a parent, sibling, or child agent's latest messages, to see what it is working on without interrupting it.",
        parameters: recentMessagesSchema,
        execute: async (_id, params) =>
          result(
            node.recentMessages(params.target, { limit: params.limit, maxChars: params.max_chars }),
          ),
      },
    );
  }
  if (options.progress ?? node.parent !== undefined) {
    tools.push({
      name: PROGRESS_NOTE_TOOL,
      label: "Progress note",
      description:
        "Tell your parent where you are in one line. Notes less than 10 seconds apart are refused.",
      parameters: noteSchema,
      execute: async (_id, params) => result(node.note(params.message)),
    });
  }
  return tools;
}
