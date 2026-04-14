import type { Awaitable } from "./shared.js";

export interface RegistryEntry<TKey extends string = string, TValue = unknown> {
  readonly key: TKey;
  readonly value: TValue;
}

export interface RegistryContract<TValue = unknown, TKey extends string = string> {
  readonly kind: "registry";
  readonly name: string;
  register(key: TKey, value: TValue): Awaitable<void>;
  has(key: TKey): boolean;
  get(key: TKey): TValue | undefined;
  delete(key: TKey): Awaitable<boolean>;
  clear(): Awaitable<void>;
  entries(): readonly RegistryEntry<TKey, TValue>[];
}

