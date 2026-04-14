export const name = "@generic-ai/plugin-storage-memory" as const;

export type MemoryRecordValue = unknown;

export interface MemoryStorageOptions {
  readonly initialData?: MemoryStorageSeed;
  readonly now?: () => number;
}

export type MemoryStorageSeed = Record<string, Record<string, MemoryRecordValue>>;

export interface MemoryRecordSnapshot<T = MemoryRecordValue> {
  readonly key: string;
  readonly value: T;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryNamespaceSnapshot {
  [key: string]: MemoryRecordSnapshot;
}

export interface MemoryStorageSnapshot {
  readonly namespaces: Record<string, MemoryNamespaceSnapshot>;
}

export interface MemoryStoragePlugin {
  readonly name: typeof name;
  readonly createStorage: typeof createMemoryStorage;
}

export interface MemoryNamespaceView {
  readonly name: string;
  readonly size: number;
  get<T = MemoryRecordValue>(key: string): T | undefined;
  has(key: string): boolean;
  set<T = MemoryRecordValue>(key: string, value: T): MemoryRecordSnapshot<T>;
  update<T = MemoryRecordValue>(
    key: string,
    updater: (current: T | undefined) => T,
  ): MemoryRecordSnapshot<T>;
  delete(key: string): boolean;
  clear(): void;
  entries<T = MemoryRecordValue>(): Array<readonly [string, T]>;
  keys(): string[];
  values<T = MemoryRecordValue>(): T[];
  list<T = MemoryRecordValue>(): Array<MemoryRecordSnapshot<T>>;
  snapshot(): MemoryNamespaceSnapshot;
  restore(snapshot: MemoryNamespaceSnapshot): void;
}

export interface MemoryStorageView {
  namespace(name: string): MemoryNamespaceView;
  namespaces(): string[];
  hasNamespace(name: string): boolean;
  deleteNamespace(name: string): boolean;
  clear(): void;
  snapshot(): MemoryStorageSnapshot;
  restore(snapshot: MemoryStorageSnapshot): void;
  transaction<T>(operation: (draft: MemoryStorageView) => T): T;
}

export class MemoryStorageError extends Error {
  constructor(
    public readonly code:
      | "INVALID_NAME"
      | "NON_CLONEABLE_VALUE"
      | "INVALID_SNAPSHOT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryStorageError";
  }
}

type StoredRecord = {
  value: MemoryRecordValue;
  version: number;
  createdAt: number;
  updatedAt: number;
};

type NamespaceState = Map<string, StoredRecord>;
type MemoryStorageInternals = {
  namespaces: Map<string, NamespaceState>;
  now: () => number;
};

const memoryStorageInternals = new WeakMap<MemoryStorage, MemoryStorageInternals>();

const storageDescriptor: MemoryStoragePlugin = Object.freeze({
  name,
  createStorage: createMemoryStorage,
});

export const memoryStoragePlugin = storageDescriptor;

export function createMemoryStorage(
  options: MemoryStorageOptions = {},
): MemoryStorage {
  return new MemoryStorage(options);
}

export class MemoryStorage implements MemoryStorageView {
  constructor(options: MemoryStorageOptions = {}) {
    const now = options.now ?? Date.now;
    memoryStorageInternals.set(this, {
      namespaces: new Map<string, NamespaceState>(),
      now,
    });

    if (options.initialData) {
      this.restore({ namespaces: seedNamespaces(options.initialData, now) });
    }
  }

  namespace(name: string): MemoryNamespace {
    const normalizedName = normalizeName(name, "namespace");
    getMemoryNamespaceState(this, normalizedName);
    return new MemoryNamespace(this, normalizedName);
  }

  namespaces(): string[] {
    return [...getMemoryStorageInternals(this).namespaces.keys()];
  }

  hasNamespace(name: string): boolean {
    return getMemoryStorageInternals(this).namespaces.has(
      normalizeName(name, "namespace"),
    );
  }

  deleteNamespace(name: string): boolean {
    return getMemoryStorageInternals(this).namespaces.delete(
      normalizeName(name, "namespace"),
    );
  }

  clear(): void {
    getMemoryStorageInternals(this).namespaces.clear();
  }

  snapshot(): MemoryStorageSnapshot {
    const namespaces: Record<string, MemoryNamespaceSnapshot> = {};
    for (const [namespaceName, namespaceState] of getMemoryStorageInternals(this)
      .namespaces) {
      namespaces[namespaceName] = snapshotNamespace(namespaceState);
    }

    return { namespaces };
  }

  restore(snapshot: MemoryStorageSnapshot): void {
    if (!isStorageSnapshot(snapshot)) {
      throw new MemoryStorageError(
        "INVALID_SNAPSHOT",
        "Expected a memory storage snapshot with a namespaces record.",
      );
    }

    const namespaces = new Map<string, NamespaceState>();
    for (const [namespaceName, namespaceSnapshot] of Object.entries(
      snapshot.namespaces,
    )) {
      namespaces.set(namespaceName, restoreNamespace(namespaceSnapshot));
    }

    getMemoryStorageInternals(this).namespaces = namespaces;
  }

  transaction<T>(operation: (draft: MemoryStorageView) => T): T {
    const internals = getMemoryStorageInternals(this);
    const draft = new MemoryStorage({ now: internals.now });
    getMemoryStorageInternals(draft).namespaces = cloneNamespaces(
      internals.namespaces,
    );
    const result = operation(draft);
    internals.namespaces = getMemoryStorageInternals(draft).namespaces;
    return result;
  }
}

export class MemoryNamespace implements MemoryNamespaceView {
  #storage: MemoryStorage;
  #name: string;

  constructor(storage: MemoryStorage, name: string) {
    this.#storage = storage;
    this.#name = normalizeName(name, "namespace");
  }

  get name(): string {
    return this.#name;
  }

  get size(): number {
    return getMemoryNamespaceState(this.#storage, this.#name).size;
  }

  get<T = MemoryRecordValue>(key: string): T | undefined {
    const record = readMemoryRecord(this.#storage, this.#name, key);
    return record ? (cloneValue(record.value) as T) : undefined;
  }

  has(key: string): boolean {
    return readMemoryRecord(this.#storage, this.#name, key) !== undefined;
  }

  set<T = MemoryRecordValue>(key: string, value: T): MemoryRecordSnapshot<T> {
    return writeMemoryRecord(this.#storage, this.#name, key, value);
  }

  update<T = MemoryRecordValue>(
    key: string,
    updater: (current: T | undefined) => T,
  ): MemoryRecordSnapshot<T> {
    const current = this.get<T>(key);
    return this.set(key, updater(current));
  }

  delete(key: string): boolean {
    return removeMemoryRecord(this.#storage, this.#name, key);
  }

  clear(): void {
    getMemoryNamespaceState(this.#storage, this.#name).clear();
  }

  entries<T = MemoryRecordValue>(): Array<readonly [string, T]> {
    return this.list<T>().map((record) => [record.key, record.value] as const);
  }

  keys(): string[] {
    return this.list().map((record) => record.key);
  }

  values<T = MemoryRecordValue>(): T[] {
    return this.list<T>().map((record) => record.value);
  }

  list<T = MemoryRecordValue>(): Array<MemoryRecordSnapshot<T>> {
    const namespaceState = getMemoryNamespaceState(this.#storage, this.#name);
    return [...namespaceState.entries()].map(([key, record]) =>
      toSnapshotRecord<T>(key, record),
    );
  }

  snapshot(): MemoryNamespaceSnapshot {
    return snapshotNamespace(getMemoryNamespaceState(this.#storage, this.#name));
  }

  restore(snapshot: MemoryNamespaceSnapshot): void {
    if (!isNamespaceSnapshot(snapshot)) {
      throw new MemoryStorageError(
        "INVALID_SNAPSHOT",
        "Expected a namespace snapshot object.",
      );
    }

    replaceMemoryNamespaceState(this.#storage, this.#name, restoreNamespace(snapshot));
  }
}

function getMemoryStorageInternals(
  storage: MemoryStorage,
): MemoryStorageInternals {
  const internals = memoryStorageInternals.get(storage);
  if (!internals) {
    throw new Error("MemoryStorage internals are unavailable.");
  }

  return internals;
}

function getMemoryNamespaceState(
  storage: MemoryStorage,
  name: string,
): NamespaceState {
  const internals = getMemoryStorageInternals(storage);
  const normalizedName = normalizeName(name, "namespace");
  const existing = internals.namespaces.get(normalizedName);
  if (existing) {
    return existing;
  }

  const namespace = new Map<string, StoredRecord>();
  internals.namespaces.set(normalizedName, namespace);
  return namespace;
}

function replaceMemoryNamespaceState(
  storage: MemoryStorage,
  name: string,
  namespaceState: NamespaceState,
): void {
  getMemoryStorageInternals(storage).namespaces.set(
    normalizeName(name, "namespace"),
    namespaceState,
  );
}

function readMemoryRecord(
  storage: MemoryStorage,
  namespace: string,
  key: string,
): StoredRecord | undefined {
  return getMemoryNamespaceState(storage, namespace).get(normalizeName(key, "key"));
}

function writeMemoryRecord<T>(
  storage: MemoryStorage,
  namespace: string,
  key: string,
  value: T,
): MemoryRecordSnapshot<T> {
  const namespaceState = getMemoryNamespaceState(storage, namespace);
  const normalizedKey = normalizeName(key, "key");
  const now = getMemoryStorageInternals(storage).now();
  const previous = namespaceState.get(normalizedKey);
  const clone = cloneValue(value);
  const stored: StoredRecord = previous
    ? {
        value: clone,
        version: previous.version + 1,
        createdAt: previous.createdAt,
        updatedAt: now,
      }
    : {
        value: clone,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

  namespaceState.set(normalizedKey, stored);
  return toSnapshotRecord(normalizedKey, stored);
}

function removeMemoryRecord(
  storage: MemoryStorage,
  namespace: string,
  key: string,
): boolean {
  const normalizedNamespace = normalizeName(namespace, "namespace");
  const namespaceState = getMemoryStorageInternals(storage).namespaces.get(
    normalizedNamespace,
  );
  if (!namespaceState) {
    return false;
  }

  return namespaceState.delete(normalizeName(key, "key"));
}

function cloneNamespaces(namespaces: Map<string, NamespaceState>): Map<string, NamespaceState> {
  const clone = new Map<string, NamespaceState>();
  for (const [namespaceName, namespaceState] of namespaces) {
    clone.set(namespaceName, cloneNamespace(namespaceState));
  }

  return clone;
}

function cloneNamespace(namespaceState: NamespaceState): NamespaceState {
  const clone = new Map<string, StoredRecord>();
  for (const [key, record] of namespaceState) {
    clone.set(key, {
      value: cloneValue(record.value),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  return clone;
}

function seedNamespaces(
  initialData: MemoryStorageSeed,
  now: () => number,
): Record<string, MemoryNamespaceSnapshot> {
  const namespaces: Record<string, MemoryNamespaceSnapshot> = {};
  for (const [namespaceName, entries] of Object.entries(initialData)) {
    const namespaceSnapshot: MemoryNamespaceSnapshot = {};
    for (const [key, value] of Object.entries(entries)) {
      const timestamp = now();
      namespaceSnapshot[normalizeName(key, "key")] = {
        key: normalizeName(key, "key"),
        value: cloneValue(value),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }

    namespaces[normalizeName(namespaceName, "namespace")] = namespaceSnapshot;
  }

  return namespaces;
}

function restoreNamespace(snapshot: MemoryNamespaceSnapshot): NamespaceState {
  const namespace = new Map<string, StoredRecord>();
  for (const [key, record] of Object.entries(snapshot)) {
    namespace.set(normalizeName(key, "key"), {
      value: cloneValue(record.value),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  return namespace;
}

function snapshotNamespace(namespaceState: NamespaceState): MemoryNamespaceSnapshot {
  const snapshot: MemoryNamespaceSnapshot = {};
  for (const [key, record] of namespaceState) {
    snapshot[key] = toSnapshotRecord(key, record);
  }

  return snapshot;
}

function toSnapshotRecord<T>(
  key: string,
  record: StoredRecord,
): MemoryRecordSnapshot<T> {
  return {
    key,
    value: cloneValue(record.value) as T,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeName(name: string, kind: "namespace" | "key"): string {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (normalizedName.length === 0) {
    throw new MemoryStorageError(
      "INVALID_NAME",
      `Expected a non-empty ${kind} name.`,
    );
  }

  return normalizedName;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new MemoryStorageError(
      "NON_CLONEABLE_VALUE",
      "Memory storage only accepts structured-cloneable values.",
      { cause: error },
    );
  }
}

function isStorageSnapshot(value: unknown): value is MemoryStorageSnapshot {
  if (!isPlainObject(value)) {
    return false;
  }

  const candidate = value as { namespaces?: unknown };
  return isPlainObject(candidate.namespaces);
}

function isNamespaceSnapshot(value: unknown): value is MemoryNamespaceSnapshot {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
