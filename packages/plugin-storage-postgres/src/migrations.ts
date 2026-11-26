import {
  type PostgresPool,
  type PostgresQueryable,
  quoteIdentifier,
  withTransaction,
} from "./client.js";

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  /** Returns the DDL for the given (already quoted) schema. */
  sql(schema: string): string;
}

/**
 * Ordered, append-only list of schema migrations. Never edit a shipped
 * migration; add a new one with the next version instead.
 */
export const postgresMigrations: readonly PostgresMigration[] = Object.freeze([
  {
    version: 1,
    name: "kv-records",
    sql: (s: string) => `
      CREATE TABLE ${s}.kv_records (
        namespace text NOT NULL,
        collection text NOT NULL,
        id text NOT NULL,
        value jsonb NOT NULL,
        metadata jsonb,
        updated_at text NOT NULL,
        PRIMARY KEY (namespace, collection, id)
      );
    `,
  },
  {
    version: 2,
    name: "run-store",
    sql: (s: string) => `
      CREATE TABLE ${s}.runs (
        run_id text PRIMARY KEY,
        root_scope_id text NOT NULL,
        status text NOT NULL,
        envelope jsonb NOT NULL,
        metadata jsonb,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX runs_created_idx ON ${s}.runs (created_at DESC, run_id DESC);
      CREATE INDEX runs_status_created_idx ON ${s}.runs (status, created_at DESC);
      CREATE INDEX runs_scope_created_idx ON ${s}.runs (root_scope_id, created_at DESC);

      CREATE TABLE ${s}.run_sessions (
        session_id text PRIMARY KEY,
        run_id text NOT NULL,
        parent_session_id text,
        agent_id text,
        status text NOT NULL,
        state jsonb,
        metadata jsonb,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        seq bigserial NOT NULL
      );
      CREATE INDEX run_sessions_run_idx ON ${s}.run_sessions (run_id, seq);

      CREATE TABLE ${s}.run_events (
        run_id text NOT NULL,
        sequence bigint NOT NULL,
        event_id text NOT NULL,
        name text NOT NULL,
        session_id text NOT NULL,
        occurred_at text NOT NULL,
        event jsonb NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE INDEX run_events_session_idx ON ${s}.run_events (session_id);
    `,
  },
  {
    version: 3,
    name: "durable-queue",
    sql: (s: string) => `
      CREATE TABLE ${s}.queue_jobs (
        id text PRIMARY KEY,
        seq bigserial NOT NULL,
        name text NOT NULL,
        payload jsonb NOT NULL,
        state text NOT NULL
          CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
        scope_id text,
        priority integer NOT NULL DEFAULT 0,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL CHECK (max_attempts >= 1),
        concurrency_key text,
        idempotency_key text UNIQUE,
        metadata jsonb,
        enqueued_at timestamptz NOT NULL,
        available_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        lease_id text UNIQUE,
        leased_by text,
        leased_at timestamptz,
        lease_expires_at timestamptz,
        last_error text,
        result jsonb,
        completed_at timestamptz,
        cancel_requested boolean NOT NULL DEFAULT false
      );
      CREATE INDEX queue_jobs_ready_idx
        ON ${s}.queue_jobs (priority DESC, available_at, seq)
        WHERE state = 'queued';
      CREATE INDEX queue_jobs_lease_expiry_idx
        ON ${s}.queue_jobs (lease_expires_at)
        WHERE state = 'leased';
      CREATE UNIQUE INDEX queue_jobs_one_lease_per_key_idx
        ON ${s}.queue_jobs (concurrency_key)
        WHERE state = 'leased' AND concurrency_key IS NOT NULL;
      CREATE INDEX queue_jobs_completed_idx
        ON ${s}.queue_jobs (completed_at)
        WHERE completed_at IS NOT NULL;
      CREATE INDEX queue_jobs_name_state_idx ON ${s}.queue_jobs (name, state);
    `,
  },
]);

export const LATEST_POSTGRES_SCHEMA_VERSION =
  postgresMigrations[postgresMigrations.length - 1]?.version ?? 0;

/** Advisory lock key used to serialize migrations across processes ("gai-migr"). */
const MIGRATION_LOCK_KEY = 0x6761692d6d696772n;

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

/**
 * Applies pending migrations in one transaction, holding an advisory lock so
 * concurrent processes starting at once do not race.
 */
export async function migratePostgres(
  pool: PostgresPool,
  schema: string,
  options: { readonly targetVersion?: number } = {},
): Promise<MigrationResult> {
  const s = quoteIdentifier(schema);
  const target = options.targetVersion ?? LATEST_POSTGRES_SCHEMA_VERSION;
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY.toString()]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const from = await currentVersion(client, s);
    const applied: number[] = [];
    for (const migration of postgresMigrations) {
      if (migration.version <= from || migration.version > target) {
        continue;
      }
      await client.query(migration.sql(s));
      await client.query(`INSERT INTO ${s}.schema_migrations (version, name) VALUES ($1, $2)`, [
        migration.version,
        migration.name,
      ]);
      applied.push(migration.version);
    }
    return { from, to: applied.at(-1) ?? from, applied };
  });
}

/** Returns the applied schema version, or 0 when the schema has not been migrated. */
export async function getPostgresSchemaVersion(
  db: PostgresQueryable,
  schema: string,
): Promise<number> {
  const exists = await db.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${quoteIdentifier(schema)}.schema_migrations`],
  );
  if (exists.rows[0]?.present !== true) {
    return 0;
  }
  return currentVersion(db, quoteIdentifier(schema));
}

async function currentVersion(db: PostgresQueryable, quotedSchema: string): Promise<number> {
  const result = await db.query<{ version: number | null }>(
    `SELECT max(version) AS version FROM ${quotedSchema}.schema_migrations`,
  );
  return result.rows[0]?.version ?? 0;
}
