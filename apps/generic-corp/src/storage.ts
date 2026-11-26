import type {
  AgentRecordStore,
  AgentTaskJobPayload,
  AgentTaskJobResult,
} from "@generic-ai/plugin-delegation";
import { createStorageAgentStore } from "@generic-ai/plugin-delegation";
import { openPostgresStorage } from "@generic-ai/plugin-storage-postgres";
import {
  createSqliteQueue,
  createSqliteRunStore,
  createSqliteStorage,
  type SqliteStorage,
} from "@generic-ai/plugin-storage-sqlite";
import type {
  DurableQueueContract,
  RunStoreContract,
  StorageContract,
  StorageFilter,
  StorageKey,
  StorageRecord,
} from "@generic-ai/sdk";

/**
 * Everything Generic Corp persists, on one backend: Postgres in production
 * (Railway, `DATABASE_URL`) and SQLite for local runs and Docker tests.
 */
export interface CompanyStorage {
  readonly driver: "postgres" | "sqlite";
  readonly runStore: RunStoreContract;
  readonly queue: DurableQueueContract<AgentTaskJobPayload, AgentTaskJobResult>;
  /** Key-value records: agents, chat threads, app settings. */
  readonly kv: StorageContract;
  readonly agents: AgentRecordStore;
  /** Readiness: the database answers and its schema is current. */
  health(): Promise<{ readonly ok: boolean; readonly error?: string }>;
  close(): Promise<void>;
}

export interface OpenCompanyStorageOptions {
  /** Postgres connection string. When set, Postgres is used. */
  readonly databaseUrl?: string;
  /** SQLite database file (or `:memory:`) when no `databaseUrl` is given. */
  readonly sqlitePath?: string;
  /** Lease length for agent turns. Defaults to 10 minutes. */
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_LEASE_MS = 10 * 60_000;
const KV_NAMESPACE_PREFIX = "kv:";

export async function openCompanyStorage(
  options: OpenCompanyStorageOptions,
): Promise<CompanyStorage> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? 3;

  if (options.databaseUrl !== undefined) {
    const postgres = await openPostgresStorage({ connectionString: options.databaseUrl });
    return {
      driver: "postgres",
      runStore: postgres.runs,
      queue: postgres.queue<AgentTaskJobPayload, AgentTaskJobResult>({ leaseMs, maxAttempts }),
      kv: postgres.storage,
      agents: createStorageAgentStore(postgres.storage, { namespace: "generic-corp" }),
      async health() {
        const health = await postgres.healthCheck();
        return { ok: health.ok, ...(health.error === undefined ? {} : { error: health.error }) };
      },
      close: () => postgres.close(),
    };
  }

  const path = options.sqlitePath ?? ":memory:";
  if (path === ":memory:") {
    throw new Error(
      "Generic Corp needs a SQLite file or DATABASE_URL: the run store and queue share one database.",
    );
  }
  const sqlite = createSqliteStorage({ path });
  const runStore = createSqliteRunStore({ path });
  const queue = createSqliteQueue<AgentTaskJobPayload, AgentTaskJobResult>({
    path,
    leaseMs,
    maxAttempts,
  });
  const kv = createSqliteStorageContract(sqlite);
  return {
    driver: "sqlite",
    runStore,
    queue,
    kv,
    agents: createStorageAgentStore(kv, { namespace: "generic-corp" }),
    async health() {
      try {
        await runStore.lastSequence("health-probe");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async close() {
      await queue.close();
      await runStore.close();
      sqlite.close();
    },
  };
}

function compositeKey(key: Pick<StorageKey, "collection" | "id">): string {
  return `${key.collection}/${key.id}`;
}

/**
 * Adapts SQLite key-value storage to the SDK `StorageContract`. Each storage
 * namespace is a SQLite namespace; collection and id form the record key.
 */
export function createSqliteStorageContract(sqlite: SqliteStorage): StorageContract {
  const namespaceOf = (name: string) => sqlite.namespace(`${KV_NAMESPACE_PREFIX}${name}`);
  const toRecord = (namespace: string, key: string, value: unknown, updatedAt: number) => {
    const separator = key.indexOf("/");
    return {
      key: {
        namespace,
        collection: key.slice(0, separator),
        id: key.slice(separator + 1),
      },
      value,
      updatedAt: new Date(updatedAt).toISOString(),
    } satisfies StorageRecord;
  };
  const listNamespace = (namespace: string, filter: StorageFilter): StorageRecord[] =>
    namespaceOf(namespace)
      .list()
      .filter((record) => {
        if (filter.collection !== undefined && !record.key.startsWith(`${filter.collection}/`)) {
          return false;
        }
        const id = record.key.slice(record.key.indexOf("/") + 1);
        return filter.prefix === undefined || id.startsWith(filter.prefix);
      })
      .map((record) => toRecord(namespace, record.key, record.value, record.updatedAt));
  const namespaces = (filter: StorageFilter): string[] =>
    filter.namespace !== undefined
      ? [filter.namespace]
      : sqlite
          .namespaces()
          .filter((name) => name.startsWith(KV_NAMESPACE_PREFIX))
          .map((name) => name.slice(KV_NAMESPACE_PREFIX.length));

  return {
    kind: "storage",
    driver: "sqlite",
    get<TValue>(key: StorageKey) {
      const namespace = namespaceOf(key.namespace);
      const id = compositeKey(key);
      if (!namespace.has(id)) {
        return undefined;
      }
      const snapshot = namespace.list<TValue>().find((record) => record.key === id);
      return snapshot === undefined
        ? undefined
        : (toRecord(
            key.namespace,
            id,
            snapshot.value,
            snapshot.updatedAt,
          ) as StorageRecord<TValue>);
    },
    set(record) {
      namespaceOf(record.key.namespace).set(compositeKey(record.key), record.value);
    },
    delete(key) {
      return namespaceOf(key.namespace).delete(compositeKey(key));
    },
    list(filter = {}) {
      return namespaces(filter).flatMap((namespace) => listNamespace(namespace, filter));
    },
    clear(filter = {}) {
      for (const namespace of namespaces(filter)) {
        for (const record of listNamespace(namespace, filter)) {
          namespaceOf(namespace).delete(compositeKey(record.key));
        }
      }
    },
  };
}
