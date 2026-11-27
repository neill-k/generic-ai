import { randomUUID } from "node:crypto";

import type { RunActor, StorageContract } from "@generic-ai/sdk";

/**
 * Chat threads between the owner and the CEO.
 *
 * A thread stores the owner's messages. Each owner message starts one root
 * task for the CEO; the CEO's answer is that task's result, read from the run
 * store, so it is never stored twice and always reflects the task's state.
 */
export interface ChatMessageRecord {
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: string;
  /** Root task this message started. */
  readonly taskId: string;
  /** Drive paths of files the owner attached. */
  readonly attachments?: readonly string[];
  readonly actor?: RunActor;
}

export interface ChatThreadRecord {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessageRecord[];
}

export interface ThreadStore {
  create(input: { readonly title: string; readonly threadId?: string }): Promise<ChatThreadRecord>;
  get(threadId: string): Promise<ChatThreadRecord | undefined>;
  list(): Promise<readonly ChatThreadRecord[]>;
  append(threadId: string, message: ChatMessageRecord): Promise<ChatThreadRecord>;
  rename(threadId: string, title: string): Promise<ChatThreadRecord>;
  delete(threadId: string): Promise<boolean>;
}

const NAMESPACE = "generic-corp";
const COLLECTION = "threads";
const MAX_TITLE = 120;

export function threadTitleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line || "New thread";
}

export function createThreadStore(
  kv: StorageContract,
  options: { readonly now?: () => Date; readonly createId?: () => string } = {},
): ThreadStore {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const keyOf = (threadId: string) => ({
    namespace: NAMESPACE,
    collection: COLLECTION,
    id: threadId,
  });

  async function load(threadId: string): Promise<ChatThreadRecord | undefined> {
    return (await kv.get<ChatThreadRecord>(keyOf(threadId)))?.value;
  }

  async function save(thread: ChatThreadRecord): Promise<ChatThreadRecord> {
    await kv.set({ key: keyOf(thread.threadId), value: thread, updatedAt: thread.updatedAt });
    return thread;
  }

  async function require(threadId: string): Promise<ChatThreadRecord> {
    const thread = await load(threadId);
    if (thread === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    return thread;
  }

  return {
    async create(input) {
      const timestamp = now().toISOString();
      return save({
        threadId: input.threadId ?? createId(),
        title: threadTitleFrom(input.title),
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      });
    },
    get: load,
    async list() {
      const records = await kv.list({ namespace: NAMESPACE, collection: COLLECTION });
      return records
        .map((record) => record.value as ChatThreadRecord)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async append(threadId, message) {
      const thread = await require(threadId);
      return save({
        ...thread,
        updatedAt: now().toISOString(),
        messages: [...thread.messages, message],
      });
    },
    async rename(threadId, title) {
      const thread = await require(threadId);
      return save({ ...thread, title: threadTitleFrom(title), updatedAt: now().toISOString() });
    },
    delete: (threadId) => Promise.resolve(kv.delete(keyOf(threadId))),
  };
}

export class ThreadNotFoundError extends Error {
  constructor(readonly threadId: string) {
    super(`Thread ${threadId} was not found.`);
    this.name = "ThreadNotFoundError";
  }
}
