export type RegistryErrorCode = "invalid-key" | "duplicate-entry" | "missing-entry";

export class RegistryError extends Error {
  override readonly name = "RegistryError";

  constructor(
    readonly code: RegistryErrorCode,
    readonly registryName: string,
    readonly key: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RegistryEntry<T> {
  readonly key: string;
  readonly value: T;
}

export interface Registry<T> {
  readonly name: string;
  readonly size: number;

  register(key: string, value: T): T;
  has(key: string): boolean;
  get(key: string): T | undefined;
  require(key: string): T;
  delete(key: string): boolean;
  clear(): void;
  entries(): readonly RegistryEntry<T>[];
  keys(): readonly string[];
  values(): readonly T[];
}

function normalizeKey(key: string, registryName: string): string {
  const normalized = key.trim();
  if (normalized.length === 0) {
    throw new RegistryError(
      "invalid-key",
      registryName,
      key,
      `Registry "${registryName}" does not accept blank keys.`,
    );
  }

  return normalized;
}

export function createRegistry<T>(name: string): Registry<T> {
  const entries = new Map<string, T>();

  return {
    name,
    get size() {
      return entries.size;
    },
    register(key, value) {
      const normalizedKey = normalizeKey(key, name);
      if (entries.has(normalizedKey)) {
        throw new RegistryError(
          "duplicate-entry",
          name,
          normalizedKey,
          `Registry "${name}" already contains an entry for "${normalizedKey}".`,
        );
      }

      entries.set(normalizedKey, value);
      return value;
    },
    has(key) {
      return entries.has(normalizeKey(key, name));
    },
    get(key) {
      return entries.get(normalizeKey(key, name));
    },
    require(key) {
      const normalizedKey = normalizeKey(key, name);
      const value = entries.get(normalizedKey);
      if (value === undefined) {
        throw new RegistryError(
          "missing-entry",
          name,
          normalizedKey,
          `Registry "${name}" does not contain an entry for "${normalizedKey}".`,
        );
      }

      return value;
    },
    delete(key) {
      return entries.delete(normalizeKey(key, name));
    },
    clear() {
      entries.clear();
    },
    entries() {
      return Array.from(entries.entries(), ([key, value]) => ({ key, value }));
    },
    keys() {
      return Array.from(entries.keys());
    },
    values() {
      return Array.from(entries.values());
    },
  };
}
