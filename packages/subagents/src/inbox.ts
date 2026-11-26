// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent, the RLM inbox).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

/** What an inbox item records: a message that arrived while idle, or a child that ended. */
export type InboxKind = "agent-message" | "child-exited" | "child-failed";

export const INBOX_KINDS: readonly InboxKind[] = ["agent-message", "child-exited", "child-failed"];

export interface InboxItem {
  readonly id: number;
  readonly kind: InboxKind;
  /** Name of the agent the item came from. */
  readonly sender: string;
  readonly text: string;
  readonly receivedAt: number;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export interface InboxFilter {
  readonly sender?: string | undefined;
  readonly kind?: InboxKind | undefined;
  /** Only items received at or after this time (ms since the epoch). */
  readonly sinceMs?: number | undefined;
  /** Only items received before this time. */
  readonly beforeMs?: number | undefined;
}

export interface InboxCount {
  readonly count: number;
  readonly oldestAt?: number | undefined;
  readonly byKind: Readonly<Record<InboxKind, number>>;
}

function matches(item: InboxItem, filter: InboxFilter): boolean {
  return (
    (filter.sender === undefined || item.sender === filter.sender) &&
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.sinceMs === undefined || item.receivedAt >= filter.sinceMs) &&
    (filter.beforeMs === undefined || item.receivedAt < filter.beforeMs)
  );
}

/** Items waiting for an agent. Reading removes what it returns. */
export class Inbox {
  readonly #now: () => number;
  #items: InboxItem[] = [];
  #nextId = 1;
  readonly #listeners = new Set<(item: InboxItem) => void>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  push(item: Omit<InboxItem, "id" | "receivedAt">): InboxItem {
    const stored: InboxItem = { ...item, id: this.#nextId, receivedAt: this.#now() };
    this.#nextId += 1;
    this.#items.push(stored);
    for (const listener of [...this.#listeners]) {
      listener(stored);
    }
    return stored;
  }

  /** Remove and return the matching items, oldest first. */
  read(filter: InboxFilter = {}): InboxItem[] {
    const taken = this.#items.filter((item) => matches(item, filter));
    this.#items = this.#items.filter((item) => !matches(item, filter));
    return taken;
  }

  /** The matching items, without removing them. */
  peek(filter: InboxFilter = {}): InboxItem[] {
    return this.#items.filter((item) => matches(item, filter));
  }

  count(filter: InboxFilter = {}): InboxCount {
    const items = this.peek(filter);
    const byKind: Record<InboxKind, number> = {
      "agent-message": 0,
      "child-exited": 0,
      "child-failed": 0,
    };
    for (const item of items) {
      byKind[item.kind] += 1;
    }
    const oldest = items[0]?.receivedAt;
    return { count: items.length, ...(oldest === undefined ? {} : { oldestAt: oldest }), byKind };
  }

  /** Call `listener` for each new item. Returns the unsubscribe function. */
  onItem(listener: (item: InboxItem) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
