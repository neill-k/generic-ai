import type { Awaitable, JsonValue } from "./shared.js";

export interface StorageKey {
  readonly namespace: string;
  readonly collection: string;
  readonly id: string;
}

export interface StorageRecord<TValue = unknown> {
  readonly key: StorageKey;
  readonly value: TValue;
  readonly updatedAt: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface StorageFilter {
  readonly namespace?: string;
  readonly collection?: string;
  readonly prefix?: string;
}

export interface StorageContract {
  readonly kind: "storage";
  readonly driver: string;
  get<TValue>(key: StorageKey): Awaitable<StorageRecord<TValue> | undefined>;
  set<TValue>(record: StorageRecord<TValue>): Awaitable<void>;
  delete(key: StorageKey): Awaitable<boolean>;
  list(filter?: StorageFilter): Awaitable<readonly StorageRecord[]>;
  clear(filter?: StorageFilter): Awaitable<void>;
}
