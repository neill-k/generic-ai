import { randomUUID } from "node:crypto";

export const name = "@generic-ai/plugin-messaging" as const;
export const kind = "messaging" as const;

export interface NamespaceRecord<TValue> {
  readonly key: string;
  readonly value: TValue;
}

export interface NamespaceStore {
  get<TValue = unknown>(key: string): TValue | undefined;
  set<TValue = unknown>(key: string, value: TValue): unknown;
  delete(key: string): boolean;
  list<TValue = unknown>(): Array<NamespaceRecord<TValue>>;
}

export interface NamespacedStorage {
  namespace(name: string): NamespaceStore;
}

export interface AgentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject?: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SendMessageInput {
  readonly id?: string;
  readonly threadId?: string;
  readonly from: string;
  readonly to: string;
  readonly subject?: string;
  readonly body: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InboxOptions {
  readonly unreadOnly?: boolean;
  readonly limit?: number;
}

export interface MessageSearchResult {
  readonly message: AgentMessage;
  readonly score: number;
  readonly matches: readonly string[];
}

export interface MessagingServiceOptions {
  readonly storage: NamespacedStorage;
  readonly namespace?: string;
  readonly idFactory?: () => string;
  readonly now?: () => string | number | Date;
}

export interface MessagingService {
  readonly name: typeof name;
  readonly kind: typeof kind;
  send(input: SendMessageInput): AgentMessage;
  get(messageId: string): AgentMessage | undefined;
  inbox(agentId: string, options?: InboxOptions): readonly AgentMessage[];
  thread(threadId: string): readonly AgentMessage[];
  markRead(messageId: string): AgentMessage | undefined;
  search(agentId: string, query: string, limit?: number): readonly MessageSearchResult[];
  clear(agentId?: string): void;
}

function normalizeTimestamp(value: MessagingServiceOptions["now"]): string {
  const current = value?.() ?? Date.now();
  const date = current instanceof Date ? current : new Date(current);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("MessagingServiceOptions.now() must return a valid date-like value.");
  }

  return date.toISOString();
}

function defaultThreadId(from: string, to: string): string {
  return [from, to].sort().join("::");
}

function sortMessages(messages: readonly AgentMessage[], direction: "asc" | "desc"): AgentMessage[] {
  const multiplier = direction === "asc" ? 1 : -1;

  return [...messages].sort((left, right) => multiplier * left.createdAt.localeCompare(right.createdAt));
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

function computeScore(message: AgentMessage, queryTokens: readonly string[]): MessageSearchResult | undefined {
  const haystack = `${message.subject ?? ""}\n${message.body}`.toLowerCase();
  const matches = queryTokens.filter((token) => haystack.includes(token));

  if (matches.length === 0) {
    return undefined;
  }

  return {
    message,
    score: matches.length,
    matches,
  };
}

export function createMessagingService(options: MessagingServiceOptions): MessagingService {
  const namespace = options.storage.namespace(options.namespace ?? "messages");
  const idFactory = options.idFactory ?? randomUUID;

  function listAll(): AgentMessage[] {
    return namespace.list<AgentMessage>().map((record) => record.value);
  }

  function findStored(messageId: string): AgentMessage | undefined {
    // Messages are keyed by id so inbox / thread lookups and updates are
    // O(1) rather than scanning the full namespace on every call.
    return namespace.get<AgentMessage>(messageId);
  }

  return Object.freeze({
    name,
    kind,
    send(input: SendMessageInput): AgentMessage {
      const id = input.id ?? idFactory();

      if (findStored(id) !== undefined) {
        throw new Error(`Message id "${id}" already exists; ids must be unique per namespace.`);
      }

      const message: AgentMessage = Object.freeze({
        id,
        threadId: input.threadId ?? defaultThreadId(input.from, input.to),
        from: input.from,
        to: input.to,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        body: input.body,
        createdAt: normalizeTimestamp(options.now),
        metadata: {
          ...(input.metadata ?? {}),
        },
      });

      namespace.set(message.id, message);
      return message;
    },
    get(messageId: string): AgentMessage | undefined {
      return findStored(messageId);
    },
    inbox(agentId: string, inboxOptions: InboxOptions = {}): readonly AgentMessage[] {
      const messages = listAll().filter((message) => {
        if (message.to !== agentId) {
          return false;
        }

        if (inboxOptions.unreadOnly && message.readAt !== undefined) {
          return false;
        }

        return true;
      });

      return sortMessages(messages, "desc").slice(0, inboxOptions.limit ?? messages.length);
    },
    thread(threadId: string): readonly AgentMessage[] {
      return sortMessages(
        listAll().filter((message) => message.threadId === threadId),
        "asc",
      );
    },
    markRead(messageId: string): AgentMessage | undefined {
      const stored = findStored(messageId);

      if (!stored) {
        return undefined;
      }

      const updated: AgentMessage = Object.freeze({
        ...stored,
        readAt: normalizeTimestamp(options.now),
      });

      namespace.set(updated.id, updated);
      return updated;
    },
    search(agentId: string, query: string, limit = 5): readonly MessageSearchResult[] {
      const queryTokens = tokenize(query);

      return listAll()
        .filter((message) => message.from === agentId || message.to === agentId)
        .map((message) => computeScore(message, queryTokens))
        .filter((result): result is MessageSearchResult => result !== undefined)
        .sort((left, right) => right.score - left.score || right.message.createdAt.localeCompare(left.message.createdAt))
        .slice(0, limit);
    },
    clear(agentId?: string): void {
      for (const record of namespace.list<AgentMessage>()) {
        if (
          agentId === undefined ||
          record.value.from === agentId ||
          record.value.to === agentId
        ) {
          namespace.delete(record.key);
        }
      }
    },
  });
}
