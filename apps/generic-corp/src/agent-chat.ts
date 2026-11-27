import { randomUUID } from "node:crypto";

import type { AgentTaskRecord, DelegationCascade } from "@generic-ai/plugin-delegation";
import type { RunActor, StorageContract } from "@generic-ai/sdk";

/**
 * The owner can message any agent, not only the CEO (decision 4).
 *
 * - A busy agent gets the message at the next step of the work it is doing (decision 5): it is
 *   added to each of its unfinished tasks as an owner note, which the running turn picks up as
 *   steering. It never waits behind the current task.
 * - An idle agent gets a new request of its own, with a goal it drafts like any other request
 *   (decision 6). Its answer is that request's result.
 * - Either way the CEO is told the owner spoke to its team directly: at the next step of its own
 *   work if it is busy, otherwise at the start of its next turn.
 */
export type AgentChatDelivery = "current-work" | "new-request";

export interface AgentChatMessage {
  readonly messageId: string;
  readonly agentId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly delivery: AgentChatDelivery;
  /** The tasks the message reached (current work) or started (new request). */
  readonly taskIds: readonly string[];
  readonly attachments?: readonly string[];
  readonly actor?: RunActor;
}

export interface AgentChatEntry {
  readonly message: AgentChatMessage;
  /** For a new request: its state and, once settled, the agent's answer. */
  readonly reply?: {
    readonly taskId: string;
    readonly status: string;
    readonly text?: string;
    readonly error?: string;
  };
}

/** A note for the CEO about an owner message to someone on its team. */
export interface CeoNote {
  readonly noteId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly delivered?: boolean;
}

const NAMESPACE = "generic-corp";
const CHATS = "agent-chats";
const CEO_NOTES = "ceo-notes";
const CEO_NOTES_ID = "pending";
const MAX_MESSAGES = 500;
const ACTIVE = new Set(["queued", "running", "waiting"]);

export interface AgentChat {
  /** Sends the owner's message to an agent. `startRequest` files a new request for an idle agent. */
  send(input: {
    readonly agentId: string;
    readonly text: string;
    readonly attachments?: readonly string[];
    readonly actor?: RunActor;
    readonly activeTasks: readonly AgentTaskRecord[];
    readonly startRequest: () => Promise<AgentTaskRecord>;
  }): Promise<AgentChatMessage>;
  history(agentId: string): Promise<readonly AgentChatEntry[]>;
  /** CEO notes not yet shown, marked as shown. For the CEO's next prompt. */
  takeCeoNotes(): Promise<readonly CeoNote[]>;
}

export function createAgentChat(options: {
  readonly kv: StorageContract;
  readonly cascade: DelegationCascade;
  readonly ceoId: string;
  /** Unfinished tasks of an agent, for telling the CEO at the next step of its own work. */
  readonly activeTasksOf: (agentId: string) => Promise<readonly AgentTaskRecord[]>;
  /** Display name of an agent for the note to the CEO. */
  readonly nameOf: (agentId: string) => Promise<string>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}): AgentChat {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const chatKey = (agentId: string) => ({ namespace: NAMESPACE, collection: CHATS, id: agentId });
  const notesKey = { namespace: NAMESPACE, collection: CEO_NOTES, id: CEO_NOTES_ID };
  // One writer per key at a time within the process.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  async function loadMessages(agentId: string): Promise<AgentChatMessage[]> {
    return [...((await options.kv.get<AgentChatMessage[]>(chatKey(agentId)))?.value ?? [])];
  }

  async function appendMessage(message: AgentChatMessage): Promise<void> {
    await serialized(async () => {
      const messages = [...(await loadMessages(message.agentId)), message].slice(-MAX_MESSAGES);
      await options.kv.set({
        key: chatKey(message.agentId),
        value: messages,
        updatedAt: message.createdAt,
      });
    });
  }

  async function noteToCeo(text: string): Promise<void> {
    const ceoWork = (await options.activeTasksOf(options.ceoId)).filter((task) =>
      ACTIVE.has(task.status),
    );
    let reached = false;
    for (const task of ceoWork) {
      reached = (await options.cascade.notify(task.taskId, text, "owner-note")) || reached;
    }
    if (reached) {
      return;
    }
    await serialized(async () => {
      const notes = (await options.kv.get<CeoNote[]>(notesKey))?.value ?? [];
      const createdAt = now().toISOString();
      await options.kv.set({
        key: notesKey,
        value: [
          ...notes.filter((note) => note.delivered !== true),
          { noteId: createId(), text, createdAt },
        ].slice(-100),
        updatedAt: createdAt,
      });
    });
  }

  return {
    async send(input) {
      const text = input.text.trim();
      if (text.length === 0) {
        throw new RangeError("The message is empty.");
      }
      const active = input.activeTasks.filter((task) => ACTIVE.has(task.status));
      const reached: string[] = [];
      for (const task of active) {
        if (await options.cascade.notify(task.taskId, text, "owner-note")) {
          reached.push(task.taskId);
        }
      }
      let delivery: AgentChatDelivery = "current-work";
      let taskIds: string[] = reached;
      if (reached.length === 0) {
        const task = await input.startRequest();
        delivery = "new-request";
        taskIds = [task.taskId];
      }
      const message: AgentChatMessage = {
        messageId: createId(),
        agentId: input.agentId,
        text,
        createdAt: now().toISOString(),
        delivery,
        taskIds,
        ...(input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: [...input.attachments] }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      };
      await appendMessage(message);
      if (input.agentId !== options.ceoId) {
        const name = await options.nameOf(input.agentId);
        const quoted = text.length > 600 ? `${text.slice(0, 599)}…` : text;
        await noteToCeo(
          `For your awareness: the owner messaged ${name} (${input.agentId}) directly` +
            `${delivery === "current-work" ? " about the work it is doing" : " with a new request"}: "${quoted}"`,
        );
      }
      return message;
    },

    async history(agentId) {
      const messages = await loadMessages(agentId);
      return Promise.all(
        messages.map(async (message): Promise<AgentChatEntry> => {
          if (message.delivery !== "new-request" || message.taskIds[0] === undefined) {
            return { message };
          }
          const task = await options.cascade.get(message.taskIds[0]);
          if (task === undefined) {
            return { message, reply: { taskId: message.taskIds[0], status: "missing" } };
          }
          const settled = task.status === "succeeded" || task.status === "failed";
          return {
            message,
            reply: {
              taskId: task.taskId,
              status: task.status,
              ...(settled && (task.handIn?.summary ?? task.outputText)
                ? { text: task.handIn?.summary ?? task.outputText }
                : {}),
              ...(task.failureMessage === undefined ? {} : { error: task.failureMessage }),
            },
          };
        }),
      );
    },

    takeCeoNotes: () =>
      serialized(async () => {
        const notes = (await options.kv.get<CeoNote[]>(notesKey))?.value ?? [];
        const fresh = notes.filter((note) => note.delivered !== true);
        if (fresh.length > 0) {
          await options.kv.set({
            key: notesKey,
            value: notes.map((note) => ({ ...note, delivered: true })),
            updatedAt: now().toISOString(),
          });
        }
        return fresh;
      }),
  };
}

/** Puts notes about the owner's direct messages into the CEO's prompt, before the task. */
export function withCeoNotes(prompt: string, notes: readonly CeoNote[]): string {
  if (notes.length === 0) {
    return prompt;
  }
  const section = [
    "## The owner spoke to your team directly",
    ...notes.map((note) => `- ${note.text}`),
  ].join("\n");
  const marker = prompt.search(/^## Task /m);
  return marker === -1
    ? `${prompt}\n\n${section}`
    : `${prompt.slice(0, marker)}${section}\n\n${prompt.slice(marker)}`;
}
