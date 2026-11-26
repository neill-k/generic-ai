import {
  type PostgresConnectionOptions,
  type PostgresPool,
  resolvePostgresConnection,
} from "./client.js";
import { PostgresKvStorage } from "./kv-storage.js";
import {
  getPostgresSchemaVersion,
  LATEST_POSTGRES_SCHEMA_VERSION,
  type MigrationResult,
  migratePostgres,
} from "./migrations.js";
import { PostgresQueue, type PostgresQueueOptions } from "./queue.js";
import { PostgresRunStore } from "./run-store.js";

export const name = "@generic-ai/plugin-storage-postgres" as const;

export * from "./client.js";
export * from "./kv-storage.js";
export * from "./migrations.js";
export * from "./queue.js";
export * from "./run-store.js";

export interface PostgresStorageOptions extends PostgresConnectionOptions {
  /**
   * Apply pending schema migrations on `open`. Defaults to `true`. Set to
   * `false` when migrations run as a separate deploy step.
   */
  readonly migrate?: boolean;
  /** Clock used for stored timestamps. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults for `queue()`. */
  readonly queue?: Omit<PostgresQueueOptions, "now">;
}

export interface PostgresStorage {
  readonly name: typeof name;
  readonly schema: string;
  readonly pool: PostgresPool;
  /** Key-value `StorageContract`. */
  readonly storage: PostgresKvStorage;
  /** Durable `RunStoreContract` for runs, sessions and event logs. */
  readonly runs: PostgresRunStore;
  /** A durable queue over the shared `queue_jobs` table. */
  queue<TPayload = unknown, TResult = unknown>(
    options?: Omit<PostgresQueueOptions, "now">,
  ): PostgresQueue<TPayload, TResult>;
  migrate(): Promise<MigrationResult>;
  schemaVersion(): Promise<number>;
  /** Checks the connection and schema version, for readiness probes. */
  healthCheck(): Promise<PostgresHealth>;
  /** Ends the pool if this storage created it. */
  close(): Promise<void>;
}

export interface PostgresHealth {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly error?: string;
}

/**
 * Opens Postgres-backed storage. Reads `DATABASE_URL` when neither `pool`
 * nor `connectionString` is given, which matches Railway's Postgres plugin.
 */
export async function openPostgresStorage(
  options: PostgresStorageOptions = {},
): Promise<PostgresStorage> {
  const { pool, ownsPool, schema } = resolvePostgresConnection(options);
  const now = options.now ?? Date.now;
  const storage: PostgresStorage = {
    name,
    schema,
    pool,
    storage: new PostgresKvStorage(pool, schema),
    runs: new PostgresRunStore(pool, schema, { now }),
    queue<TPayload = unknown, TResult = unknown>(
      queueOptions: Omit<PostgresQueueOptions, "now"> = {},
    ) {
      return new PostgresQueue<TPayload, TResult>(pool, schema, {
        ...options.queue,
        ...queueOptions,
        now,
      });
    },
    migrate: () => migratePostgres(pool, schema),
    schemaVersion: () => getPostgresSchemaVersion(pool, schema),
    async healthCheck() {
      try {
        const schemaVersion = await getPostgresSchemaVersion(pool, schema);
        return {
          ok: schemaVersion === LATEST_POSTGRES_SCHEMA_VERSION,
          schemaVersion,
          expectedSchemaVersion: LATEST_POSTGRES_SCHEMA_VERSION,
          ...(schemaVersion === LATEST_POSTGRES_SCHEMA_VERSION
            ? {}
            : { error: `Schema is at version ${schemaVersion}; run migrations.` }),
        };
      } catch (error) {
        return {
          ok: false,
          schemaVersion: 0,
          expectedSchemaVersion: LATEST_POSTGRES_SCHEMA_VERSION,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };

  if (options.migrate ?? true) {
    try {
      await storage.migrate();
    } catch (error) {
      await storage.close();
      throw error;
    }
  }
  return storage;
}

export interface PostgresStoragePlugin {
  readonly name: typeof name;
  readonly open: typeof openPostgresStorage;
}

export const postgresStoragePlugin: PostgresStoragePlugin = Object.freeze({
  name,
  open: openPostgresStorage,
});
