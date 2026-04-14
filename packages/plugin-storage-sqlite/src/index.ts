import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";

export const name = "@generic-ai/plugin-storage-sqlite" as const;

export interface SqliteStorageOptions {
  readonly path: string | URL;
  readonly migrate?: boolean;
  readonly busyTimeoutMs?: number;
  readonly now?: () => number;
}

export interface SqliteStoragePlugin {
  readonly name: typeof name;
  readonly createStorage: typeof createSqliteStorage;
}

export interface SqliteRecordSnapshot<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SqliteNamespaceSnapshot {
  [key: string]: SqliteRecordSnapshot;
}

export interface SqliteStorageSnapshot {
  readonly namespaces: Record<string, SqliteNamespaceSnapshot>;
}

export interface SqliteNamespaceView {
  readonly name: string;
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  set<T = unknown>(key: string, value: T): SqliteRecordSnapshot<T>;
  update<T = unknown>(
    key: string,
    updater: (current: T | undefined) => T,
  ): SqliteRecordSnapshot<T>;
  delete(key: string): boolean;
  clear(): void;
  entries<T = unknown>(): Array<readonly [string, T]>;
  keys(): string[];
  values<T = unknown>(): T[];
  list<T = unknown>(): Array<SqliteRecordSnapshot<T>>;
  snapshot(): SqliteNamespaceSnapshot;
  restore(snapshot: SqliteNamespaceSnapshot): void;
}

export class SqliteStorageError extends Error {
  constructor(
    public readonly code:
      | "INVALID_NAME"
      | "INVALID_PATH"
      | "NON_SERIALIZABLE_VALUE"
      | "INVALID_SNAPSHOT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteStorageError";
  }
}

type RecordRow = {
  namespace: string;
  key: string;
  value: Uint8Array;
  version: number;
  created_at: number;
  updated_at: number;
};

const CURRENT_SCHEMA_VERSION = 1;
type SqliteStorageInternals = {
  db: DatabaseSync;
  now: () => number;
};

const sqliteStorageInternals = new WeakMap<SqliteStorage, SqliteStorageInternals>();

export const sqliteStoragePlugin: SqliteStoragePlugin = Object.freeze({
  name,
  createStorage: createSqliteStorage,
});

export class SqliteStorage {
  readonly path: string;

  constructor(options: SqliteStorageOptions) {
    const databasePath = normalizeDatabasePath(options.path);
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    const db = new DatabaseSync(databasePath, {
      timeout: options.busyTimeoutMs ?? 5_000,
    });
    this.path = databasePath;
    sqliteStorageInternals.set(this, {
      db,
      now: options.now ?? Date.now,
    });

    try {
      configureDatabase(db, databasePath);

      if (options.migrate ?? true) {
        this.migrate();
      }
    } catch (error) {
      if (db.isOpen) {
        db.close();
      }

      throw error;
    }
  }

  namespace(name: string): SqliteNamespace {
    return new SqliteNamespace(this, normalizeName(name, "namespace"));
  }

  namespaces(): string[] {
    const rows = getSqliteStorageInternals(this).db
      .prepare("SELECT DISTINCT namespace FROM records ORDER BY namespace")
      .all() as Array<{ namespace: string }>;

    return rows.map((row) => row.namespace);
  }

  hasNamespace(name: string): boolean {
    const row = getSqliteStorageInternals(this).db
      .prepare("SELECT 1 AS present FROM records WHERE namespace = ? LIMIT 1")
      .get(normalizeName(name, "namespace")) as { present?: number } | undefined;

    return row?.present === 1;
  }

  deleteNamespace(name: string): boolean {
    const result = getSqliteStorageInternals(this).db
      .prepare("DELETE FROM records WHERE namespace = ?")
      .run(normalizeName(name, "namespace"));

    return Number(result.changes) > 0;
  }

  clear(): void {
    getSqliteStorageInternals(this).db.exec("DELETE FROM records");
  }

  snapshot(): SqliteStorageSnapshot {
    const snapshot: Record<string, SqliteNamespaceSnapshot> = {};
    const rows = getSqliteStorageInternals(this).db
      .prepare(
        "SELECT namespace, key, value, version, created_at, updated_at FROM records ORDER BY namespace, key",
      )
      .all() as RecordRow[];

    for (const row of rows) {
      const namespaceSnapshot = snapshot[row.namespace] ?? {};
      namespaceSnapshot[row.key] = {
        key: row.key,
        value: decodeValue(row.value),
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      snapshot[row.namespace] = namespaceSnapshot;
    }

    return { namespaces: snapshot };
  }

  restore(snapshot: SqliteStorageSnapshot): void {
    if (!isStorageSnapshot(snapshot)) {
      throw new SqliteStorageError(
        "INVALID_SNAPSHOT",
        "Expected a storage snapshot with a namespaces record.",
      );
    }

    this.transaction(() => {
      this.clear();
      const insert = getSqliteStorageInternals(this).db.prepare(
        "INSERT INTO records (namespace, key, value, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );

      for (const [namespaceName, namespaceSnapshot] of Object.entries(snapshot.namespaces)) {
        const normalizedNamespace = normalizeName(namespaceName, "namespace");
        for (const [key, record] of Object.entries(namespaceSnapshot)) {
          insert.run(
            normalizedNamespace,
            normalizeName(key, "key"),
            encodeValue(record.value),
            record.version,
            record.createdAt,
            record.updatedAt,
          );
        }
      }
    });
  }

  transaction<T>(operation: () => T): T {
    return runSqliteTransaction(this, operation);
  }

  migrate(): number {
    return migrateSqliteStorage(this);
  }

  close(): void {
    const { db } = getSqliteStorageInternals(this);
    if (db.isOpen) {
      db.close();
    }
  }
}

export class SqliteNamespace implements SqliteNamespaceView {
  #storage: SqliteStorage;
  #name: string;

  constructor(storage: SqliteStorage, name: string) {
    this.#storage = storage;
    this.#name = normalizeName(name, "namespace");
  }

  get name(): string {
    return this.#name;
  }

  get<T = unknown>(key: string): T | undefined {
    const record = readSqliteRecord(this.#storage, this.#name, key);
    return record ? decodeValue<T>(record.value) : undefined;
  }

  has(key: string): boolean {
    return readSqliteRecord(this.#storage, this.#name, key) !== undefined;
  }

  set<T = unknown>(key: string, value: T): SqliteRecordSnapshot<T> {
    return writeSqliteRecord(this.#storage, this.#name, key, value);
  }

  update<T = unknown>(
    key: string,
    updater: (current: T | undefined) => T,
  ): SqliteRecordSnapshot<T> {
    return this.set(key, updater(this.get<T>(key)));
  }

  delete(key: string): boolean {
    return removeSqliteRecord(this.#storage, this.#name, key);
  }

  clear(): void {
    this.#storage.deleteNamespace(this.#name);
  }

  entries<T = unknown>(): Array<readonly [string, T]> {
    return this.list<T>().map((record) => [record.key, record.value] as const);
  }

  keys(): string[] {
    return this.list().map((record) => record.key);
  }

  values<T = unknown>(): T[] {
    return this.list<T>().map((record) => record.value);
  }

  list<T = unknown>(): Array<SqliteRecordSnapshot<T>> {
    return listSqliteRecords<T>(this.#storage, this.#name);
  }

  snapshot(): SqliteNamespaceSnapshot {
    const snapshot: SqliteNamespaceSnapshot = {};
    for (const record of this.list()) {
      snapshot[record.key] = record;
    }

    return snapshot;
  }

  restore(snapshot: SqliteNamespaceSnapshot): void {
    if (!isNamespaceSnapshot(snapshot)) {
      throw new SqliteStorageError(
        "INVALID_SNAPSHOT",
        "Expected a namespace snapshot object.",
      );
    }

    restoreSqliteNamespace(this.#storage, this.#name, snapshot);
  }
}

export function createSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return new SqliteStorage(options);
}

function getSqliteStorageInternals(
  storage: SqliteStorage,
): SqliteStorageInternals {
  const internals = sqliteStorageInternals.get(storage);
  if (!internals) {
    throw new Error("SqliteStorage internals are unavailable.");
  }

  return internals;
}

function runSqliteTransaction<T>(
  storage: SqliteStorage,
  operation: () => T,
): T {
  const { db } = getSqliteStorageInternals(storage);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateSqliteStorage(storage: SqliteStorage): number {
  const { db } = getSqliteStorageInternals(storage);
  const current = db.prepare("PRAGMA user_version").get() as {
    user_version?: number;
  };
  const version = current.user_version ?? 0;

  if (version >= CURRENT_SCHEMA_VERSION) {
    return version;
  }

  runSqliteTransaction(storage, () => {
    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value BLOB NOT NULL,
          version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_records_namespace
        ON records (namespace);

      `);
    }
  });

  db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);

  return CURRENT_SCHEMA_VERSION;
}

function readSqliteRecord(
  storage: SqliteStorage,
  namespaceName: string,
  key: string,
): RecordRow | undefined {
  return getSqliteStorageInternals(storage).db
    .prepare(
      "SELECT namespace, key, value, version, created_at, updated_at FROM records WHERE namespace = ? AND key = ? LIMIT 1",
    )
    .get(
      normalizeName(namespaceName, "namespace"),
      normalizeName(key, "key"),
    ) as RecordRow | undefined;
}

function writeSqliteRecord<T>(
  storage: SqliteStorage,
  namespaceName: string,
  key: string,
  value: T,
): SqliteRecordSnapshot<T> {
  const { db, now: clock } = getSqliteStorageInternals(storage);
  const encoded = encodeValue(value);
  const normalizedNamespace = normalizeName(namespaceName, "namespace");
  const normalizedKey = normalizeName(key, "key");
  const now = clock();
  const existing = readSqliteRecord(storage, normalizedNamespace, normalizedKey);

  if (existing) {
    db.prepare(
      "UPDATE records SET value = ?, version = version + 1, updated_at = ? WHERE namespace = ? AND key = ?",
    ).run(encoded, now, normalizedNamespace, normalizedKey);

    return {
      key: normalizedKey,
      value: decodeValue(encoded),
      version: existing.version + 1,
      createdAt: existing.created_at,
      updatedAt: now,
    };
  }

  db.prepare(
    "INSERT INTO records (namespace, key, value, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(normalizedNamespace, normalizedKey, encoded, 1, now, now);

  return {
    key: normalizedKey,
    value: decodeValue(encoded),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function removeSqliteRecord(
  storage: SqliteStorage,
  namespaceName: string,
  key: string,
): boolean {
  const result = getSqliteStorageInternals(storage).db
    .prepare("DELETE FROM records WHERE namespace = ? AND key = ?")
    .run(
      normalizeName(namespaceName, "namespace"),
      normalizeName(key, "key"),
    );

  return Number(result.changes) > 0;
}

function listSqliteRecords<T = unknown>(
  storage: SqliteStorage,
  namespaceName: string,
): Array<SqliteRecordSnapshot<T>> {
  const rows = getSqliteStorageInternals(storage).db
    .prepare(
      "SELECT namespace, key, value, version, created_at, updated_at FROM records WHERE namespace = ? ORDER BY key",
    )
    .all(normalizeName(namespaceName, "namespace")) as RecordRow[];

  return rows.map((row) => ({
    key: row.key,
    value: decodeValue<T>(row.value),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function restoreSqliteNamespace(
  storage: SqliteStorage,
  namespaceName: string,
  snapshot: SqliteNamespaceSnapshot,
): void {
  runSqliteTransaction(storage, () => {
    storage.deleteNamespace(namespaceName);
    const insert = getSqliteStorageInternals(storage).db.prepare(
      "INSERT INTO records (namespace, key, value, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );

    for (const [key, record] of Object.entries(snapshot)) {
      insert.run(
        normalizeName(namespaceName, "namespace"),
        normalizeName(key, "key"),
        encodeValue(record.value),
        record.version,
        record.createdAt,
        record.updatedAt,
      );
    }
  });
}

function normalizeDatabasePath(input: string | URL): string {
  const value = input instanceof URL ? fileURLToPath(input) : input;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SqliteStorageError("INVALID_PATH", "Expected a non-empty SQLite database path.");
  }

  return value === ":memory:" ? value : path.resolve(value);
}

function configureDatabase(database: DatabaseSync, databasePath: string): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  if (databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
}

function normalizeName(name: string, kind: "namespace" | "key"): string {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (normalizedName.length === 0) {
    throw new SqliteStorageError(
      "INVALID_NAME",
      `Expected a non-empty ${kind} name.`,
    );
  }

  return normalizedName;
}

function encodeValue(value: unknown): Uint8Array {
  try {
    return serialize(value);
  } catch (error) {
    throw new SqliteStorageError(
      "NON_SERIALIZABLE_VALUE",
      "SQLite storage only accepts serializable values.",
      { cause: error },
    );
  }
}

function decodeValue<T>(value: Uint8Array): T {
  return deserialize(Buffer.from(value)) as T;
}

function isStorageSnapshot(value: unknown): value is SqliteStorageSnapshot {
  return (
    isPlainObject(value) &&
    "namespaces" in value &&
    isPlainObject((value as { namespaces?: unknown }).namespaces)
  );
}

function isNamespaceSnapshot(value: unknown): value is SqliteNamespaceSnapshot {
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
