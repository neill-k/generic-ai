import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type AppendEventsResult,
  type CanonicalEvent,
  computeQueueBackoffMs,
  type DurableQueueBackoff,
  type DurableQueueContract,
  type DurableQueueEnqueueInput,
  DurableQueueError,
  type DurableQueueJob,
  type DurableQueueLease,
  type DurableQueueLeaseOptions,
  type DurableQueueListFilter,
  type DurableQueueNackOptions,
  type DurableQueueStats,
  type JsonValue,
  type QueueJobState,
  type ReadEventsOptions,
  type RunEnvelope,
  type RunListFilter,
  type RunRecord,
  type RunStoreContract,
  RunStoreError,
  type SaveRunInput,
  type SaveSessionInput,
  type SessionRecord,
  type SessionRecordStatus,
} from "@generic-ai/sdk";

/*
 * SQLite implementations of the durable run store and queue contracts, for
 * local development and single-node deployments. They share the database
 * file with `SqliteStorage` but track their own schema in
 * `gai_schema_migrations`, so the key-value `records` schema is untouched.
 */

export interface SqliteDurableOptions {
  readonly path: string | URL;
  readonly busyTimeoutMs?: number;
  readonly now?: () => number;
}

const MIGRATIONS: ReadonlyArray<{ readonly version: number; readonly sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS gai_runs (
        run_id TEXT PRIMARY KEY,
        root_scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        envelope TEXT NOT NULL,
        metadata TEXT,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gai_runs_created_idx ON gai_runs (created_at DESC, run_id DESC);

      CREATE TABLE IF NOT EXISTS gai_run_sessions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        parent_session_id TEXT,
        agent_id TEXT,
        status TEXT NOT NULL,
        state TEXT,
        metadata TEXT,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gai_run_sessions_run_idx ON gai_run_sessions (run_id, seq);

      CREATE TABLE IF NOT EXISTS gai_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS gai_queue_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        scope_id TEXT,
        priority INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        concurrency_key TEXT,
        idempotency_key TEXT UNIQUE,
        metadata TEXT,
        enqueued_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_id TEXT UNIQUE,
        leased_by TEXT,
        leased_at INTEGER,
        lease_expires_at INTEGER,
        last_error TEXT,
        result TEXT,
        completed_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS gai_queue_ready_idx
        ON gai_queue_jobs (state, priority DESC, available_at, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS gai_queue_one_lease_per_key_idx
        ON gai_queue_jobs (concurrency_key)
        WHERE state = 'leased' AND concurrency_key IS NOT NULL;
    `,
  },
];

function openDatabase(options: SqliteDurableOptions): DatabaseSync {
  const raw = options.path instanceof URL ? fileURLToPath(options.path) : options.path;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError("Expected a non-empty SQLite database path.");
  }
  const databasePath = raw === ":memory:" ? raw : path.resolve(raw);
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath, { timeout: options.busyTimeoutMs ?? 5_000 });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (databasePath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
    }
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function migrate(db: DatabaseSync): void {
  transaction(db, () => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS gai_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    const row = db.prepare("SELECT max(version) AS version FROM gai_schema_migrations").get() as {
      version: number | null;
    };
    const current = row.version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO gai_schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          Date.now(),
        );
      }
    }
  });
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
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

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function iso(epoch: number): string {
  return new Date(epoch).toISOString();
}

function epochOf(value: string | number): number {
  const epoch = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new TypeError(`Invalid timestamp: ${String(value)}`);
  }
  return epoch;
}

type RunRow = {
  run_id: string;
  envelope: string;
  metadata: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type SessionRow = {
  session_id: string;
  run_id: string;
  parent_session_id: string | null;
  agent_id: string | null;
  status: SessionRecordStatus;
  state: string | null;
  metadata: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

export class SqliteRunStore implements RunStoreContract {
  readonly kind = "run-store" as const;
  readonly driver = "sqlite";
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(options: SqliteDurableOptions) {
    this.#db = openDatabase(options);
    this.#now = options.now ?? Date.now;
  }

  async saveRun<TOutput = unknown>(input: SaveRunInput<TOutput>): Promise<RunRecord<TOutput>> {
    const { envelope } = input;
    if (typeof envelope?.runId !== "string" || envelope.runId.length === 0) {
      throw new RunStoreError("INVALID_INPUT", "Run envelope must carry a runId.");
    }
    return transaction(this.#db, () => {
      const now = this.#now();
      const existing = this.#db
        .prepare("SELECT version, metadata FROM gai_runs WHERE run_id = ?")
        .get(envelope.runId) as { version: number; metadata: string | null } | undefined;
      const expected = input.expectedVersion;
      if (expected !== undefined && (existing?.version ?? 0) !== expected) {
        throw new RunStoreError(
          "VERSION_CONFLICT",
          `Run "${envelope.runId}" is not at expected version ${expected}.`,
        );
      }
      if (existing) {
        this.#db
          .prepare(
            `UPDATE gai_runs SET root_scope_id = ?, status = ?, envelope = ?, metadata = ?,
             version = version + 1, updated_at = ? WHERE run_id = ?`,
          )
          .run(
            envelope.rootScopeId,
            envelope.status,
            JSON.stringify(envelope),
            json(input.metadata) ?? existing.metadata,
            now,
            envelope.runId,
          );
      } else {
        this.#db
          .prepare(
            `INSERT INTO gai_runs (run_id, root_scope_id, status, envelope, metadata, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            envelope.runId,
            envelope.rootScopeId,
            envelope.status,
            JSON.stringify(envelope),
            json(input.metadata),
            now,
            now,
          );
      }
      return this.#readRun<TOutput>(envelope.runId) as RunRecord<TOutput>;
    });
  }

  async getRun<TOutput = unknown>(runId: string): Promise<RunRecord<TOutput> | undefined> {
    return this.#readRun<TOutput>(runId);
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly RunRecord[]> {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    if (filter.rootScopeId !== undefined) {
      conditions.push("root_scope_id = ?");
      values.push(filter.rootScopeId);
    }
    if (filter.createdBefore !== undefined) {
      conditions.push("created_at < ?");
      values.push(epochOf(filter.createdBefore));
    }
    let limit = "";
    if (filter.limit !== undefined) {
      limit = "LIMIT ?";
      values.push(positive(filter.limit, "limit", runStoreInvalid));
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT * FROM gai_runs ${where} ORDER BY created_at DESC, run_id DESC ${limit}`)
      .all(...values) as RunRow[];
    return rows.map((row) => toRunRecord(row));
  }

  async deleteRun(runId: string): Promise<boolean> {
    return transaction(this.#db, () => {
      this.#db.prepare("DELETE FROM gai_run_events WHERE run_id = ?").run(runId);
      this.#db.prepare("DELETE FROM gai_run_sessions WHERE run_id = ?").run(runId);
      const result = this.#db.prepare("DELETE FROM gai_runs WHERE run_id = ?").run(runId);
      return Number(result.changes) > 0;
    });
  }

  async saveSession(input: SaveSessionInput): Promise<SessionRecord> {
    if (input.sessionId.length === 0 || input.runId.length === 0) {
      throw new RunStoreError("INVALID_INPUT", "Sessions need a sessionId and a runId.");
    }
    return transaction(this.#db, () => {
      const now = this.#now();
      const existing = this.#db
        .prepare("SELECT version, metadata FROM gai_run_sessions WHERE session_id = ?")
        .get(input.sessionId) as { version: number; metadata: string | null } | undefined;
      if (
        input.expectedVersion !== undefined &&
        (existing?.version ?? 0) !== input.expectedVersion
      ) {
        throw new RunStoreError(
          "VERSION_CONFLICT",
          `Session "${input.sessionId}" is not at expected version ${input.expectedVersion}.`,
        );
      }
      const values = [
        input.runId,
        input.parentSessionId ?? null,
        input.agentId ?? null,
        input.status,
        json(input.state),
      ] as const;
      if (existing) {
        this.#db
          .prepare(
            `UPDATE gai_run_sessions SET run_id = ?, parent_session_id = ?, agent_id = ?, status = ?,
             state = ?, metadata = ?, version = version + 1, updated_at = ? WHERE session_id = ?`,
          )
          .run(...values, json(input.metadata) ?? existing.metadata, now, input.sessionId);
      } else {
        this.#db
          .prepare(
            `INSERT INTO gai_run_sessions (session_id, run_id, parent_session_id, agent_id, status,
             state, metadata, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(input.sessionId, ...values, json(input.metadata), now, now);
      }
      return toSessionRecord(
        this.#db
          .prepare("SELECT * FROM gai_run_sessions WHERE session_id = ?")
          .get(input.sessionId) as SessionRow,
      );
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM gai_run_sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  async listSessions(runId: string): Promise<readonly SessionRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM gai_run_sessions WHERE run_id = ? ORDER BY seq")
      .all(runId) as SessionRow[];
    return rows.map(toSessionRecord);
  }

  async appendEvents(
    runId: string,
    events: readonly CanonicalEvent[],
  ): Promise<AppendEventsResult> {
    for (const event of events) {
      if (event.runId !== runId) {
        throw new RunStoreError(
          "INVALID_INPUT",
          `Event "${event.eventId}" belongs to run "${event.runId}", not "${runId}".`,
        );
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
        throw new RunStoreError(
          "INVALID_INPUT",
          `Event "${event.eventId}" has invalid sequence ${String(event.sequence)}; sequences start at 1.`,
        );
      }
    }
    return transaction(this.#db, () => {
      const lookup = this.#db.prepare(
        "SELECT event_id FROM gai_run_events WHERE run_id = ? AND sequence = ?",
      );
      const insert = this.#db.prepare(
        "INSERT INTO gai_run_events (run_id, sequence, event_id, event) VALUES (?, ?, ?, ?)",
      );
      let appended = 0;
      for (const event of events) {
        const existing = lookup.get(runId, event.sequence) as { event_id: string } | undefined;
        if (existing) {
          if (existing.event_id !== event.eventId) {
            throw new RunStoreError(
              "SEQUENCE_CONFLICT",
              `Run "${runId}" already has a different event at sequence ${event.sequence}.`,
            );
          }
          continue;
        }
        insert.run(runId, event.sequence, event.eventId, JSON.stringify(event));
        appended += 1;
      }
      return { appended, lastSequence: this.#lastSequence(runId) };
    });
  }

  async readEvents(
    runId: string,
    options: ReadEventsOptions = {},
  ): Promise<readonly CanonicalEvent[]> {
    const values: number[] = [options.fromSequence ?? 0];
    let limit = "";
    if (options.limit !== undefined) {
      limit = "LIMIT ?";
      values.push(positive(options.limit, "limit", runStoreInvalid));
    }
    const rows = this.#db
      .prepare(
        `SELECT event FROM gai_run_events WHERE run_id = ? AND sequence >= ? ORDER BY sequence ${limit}`,
      )
      .all(runId, ...values) as Array<{ event: string }>;
    return rows.map((row) => JSON.parse(row.event) as CanonicalEvent);
  }

  async lastSequence(runId: string): Promise<number> {
    return this.#lastSequence(runId);
  }

  async close(): Promise<void> {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  #lastSequence(runId: string): number {
    const row = this.#db
      .prepare("SELECT max(sequence) AS last FROM gai_run_events WHERE run_id = ?")
      .get(runId) as { last: number | null };
    return row.last ?? 0;
  }

  #readRun<TOutput>(runId: string): RunRecord<TOutput> | undefined {
    const row = this.#db.prepare("SELECT * FROM gai_runs WHERE run_id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ? toRunRecord<TOutput>(row) : undefined;
  }
}

function toRunRecord<TOutput = unknown>(row: RunRow): RunRecord<TOutput> {
  const metadata = parse<Readonly<Record<string, JsonValue>>>(row.metadata);
  return {
    runId: row.run_id,
    envelope: JSON.parse(row.envelope) as RunEnvelope<TOutput>,
    ...(metadata === undefined ? {} : { metadata }),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  const state = parse<JsonValue>(row.state);
  const metadata = parse<Readonly<Record<string, JsonValue>>>(row.metadata);
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    status: row.status,
    ...(state === undefined ? {} : { state }),
    ...(metadata === undefined ? {} : { metadata }),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface SqliteQueueOptions extends SqliteDurableOptions {
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly backoff?: DurableQueueBackoff;
}

type JobRow = {
  id: string;
  name: string;
  payload: string;
  state: QueueJobState;
  scope_id: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  concurrency_key: string | null;
  idempotency_key: string | null;
  metadata: string | null;
  enqueued_at: number;
  available_at: number;
  updated_at: number;
  lease_id: string | null;
  leased_by: string | null;
  leased_at: number | null;
  lease_expires_at: number | null;
  last_error: string | null;
  result: string | null;
  completed_at: number | null;
  cancel_requested: number;
};

const LEASE_EXPIRED_MESSAGE = "Lease expired before the job was acknowledged.";

export class SqliteQueue<TPayload = unknown, TResult = unknown>
  implements DurableQueueContract<TPayload, TResult>
{
  readonly kind = "queue" as const;
  readonly driver = "sqlite";
  readonly durable = true as const;
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  readonly #backoff: DurableQueueBackoff;

  constructor(options: SqliteQueueOptions) {
    this.#maxAttempts = positive(options.maxAttempts ?? 3, "maxAttempts", queueInvalid);
    this.#leaseMs = positive(options.leaseMs ?? 30_000, "leaseMs", queueInvalid);
    this.#backoff = options.backoff ?? { baseMs: 1_000, maxMs: 60_000, factor: 2 };
    this.#now = options.now ?? Date.now;
    this.#db = openDatabase(options);
  }

  async enqueue(
    input: DurableQueueEnqueueInput<TPayload>,
  ): Promise<DurableQueueJob<TPayload, TResult>> {
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw queueInvalid("Queue jobs need a non-empty name.");
    }
    if (input.payload === undefined) {
      throw queueInvalid("Queue job payload must not be undefined.");
    }
    const maxAttempts = positive(
      input.maxAttempts ?? this.#maxAttempts,
      "maxAttempts",
      queueInvalid,
    );
    const id = input.id ?? randomUUID();
    return transaction(this.#db, () => {
      if (input.idempotencyKey !== undefined) {
        const existing = this.#db
          .prepare("SELECT * FROM gai_queue_jobs WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as JobRow | undefined;
        if (existing) {
          return this.#toJob(existing);
        }
      }
      if (this.#db.prepare("SELECT 1 FROM gai_queue_jobs WHERE id = ?").get(id)) {
        throw queueInvalid(`A queue job with id "${id}" already exists.`);
      }
      const now = this.#now();
      this.#db
        .prepare(
          `INSERT INTO gai_queue_jobs (id, name, payload, state, scope_id, priority, attempts,
           max_attempts, concurrency_key, idempotency_key, metadata, enqueued_at, available_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          JSON.stringify(input.payload),
          input.scopeId ?? null,
          Math.trunc(input.priority ?? 0),
          maxAttempts,
          input.concurrencyKey ?? null,
          input.idempotencyKey ?? null,
          json(input.metadata),
          now,
          input.availableAt === undefined ? now : epochOf(input.availableAt),
          now,
        );
      return this.#toJob(this.#row("id", id) as JobRow);
    });
  }

  async lease(
    options: DurableQueueLeaseOptions = {},
  ): Promise<DurableQueueLease<TPayload> | undefined> {
    const leaseMs = positive(options.leaseMs ?? this.#leaseMs, "leaseMs", queueInvalid);
    return transaction(this.#db, () => {
      this.#reclaim();
      const now = this.#now();
      const names = options.names;
      const nameClause =
        names === undefined ? "" : `AND c.name IN (${names.map(() => "?").join(", ") || "NULL"})`;
      const candidate = this.#db
        .prepare(
          `SELECT c.id FROM gai_queue_jobs AS c
           WHERE c.state = 'queued' AND c.available_at <= ? ${nameClause}
             AND (c.concurrency_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM gai_queue_jobs AS l
               WHERE l.state = 'leased' AND l.concurrency_key = c.concurrency_key))
           ORDER BY c.priority DESC, c.available_at, c.seq
           LIMIT 1`,
        )
        .get(now, ...(names ?? [])) as { id: string } | undefined;
      if (!candidate) {
        return undefined;
      }
      this.#db
        .prepare(
          `UPDATE gai_queue_jobs SET state = 'leased', attempts = attempts + 1, lease_id = ?,
           leased_by = ?, leased_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(randomUUID(), options.workerId ?? null, now, now + leaseMs, now, candidate.id);
      return this.#toJob(this.#row("id", candidate.id) as JobRow) as DurableQueueLease<TPayload>;
    });
  }

  async heartbeat(leaseId: string, leaseMs?: number): Promise<boolean> {
    const now = this.#now();
    const extension = positive(leaseMs ?? this.#leaseMs, "leaseMs", queueInvalid);
    const row = this.#db
      .prepare(
        `UPDATE gai_queue_jobs SET lease_expires_at = ?, updated_at = ?
         WHERE lease_id = ? AND state = 'leased' RETURNING cancel_requested`,
      )
      .get(now + extension, now, leaseId) as { cancel_requested: number } | undefined;
    return row !== undefined && row.cancel_requested === 0;
  }

  async ack(leaseId: string, result?: TResult): Promise<DurableQueueJob<TPayload, TResult>> {
    const now = this.#now();
    const row = this.#db
      .prepare(
        `UPDATE gai_queue_jobs SET state = 'succeeded', result = ?, completed_at = ?, updated_at = ?,
         lease_id = NULL, lease_expires_at = NULL
         WHERE lease_id = ? AND state = 'leased' RETURNING *`,
      )
      .get(json(result), now, now, leaseId) as JobRow | undefined;
    if (!row) {
      throw leaseLost(leaseId);
    }
    return this.#toJob(row);
  }

  async nack(
    leaseId: string,
    options: DurableQueueNackOptions = {},
  ): Promise<DurableQueueJob<TPayload, TResult>> {
    return transaction(this.#db, () => {
      const current = this.#row("lease_id", leaseId);
      if (!current || current.state !== "leased") {
        throw leaseLost(leaseId);
      }
      const now = this.#now();
      const terminal =
        current.cancel_requested === 1 ||
        options.retryable === false ||
        current.attempts >= current.max_attempts;
      const state: QueueJobState =
        current.cancel_requested === 1 ? "cancelled" : terminal ? "failed" : "queued";
      const delayMs =
        options.delayMs === undefined
          ? computeQueueBackoffMs(this.#backoff, current.attempts)
          : Math.max(0, options.delayMs);
      this.#db
        .prepare(
          `UPDATE gai_queue_jobs SET state = ?, available_at = ?, completed_at = ?,
           last_error = COALESCE(?, last_error), lease_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          state,
          terminal ? current.available_at : now + delayMs,
          terminal ? now : null,
          options.reason ?? null,
          now,
          current.id,
        );
      return this.#toJob(this.#row("id", current.id) as JobRow);
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    const now = this.#now();
    const row = this.#db
      .prepare(
        `UPDATE gai_queue_jobs SET
           state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
           completed_at = CASE WHEN state = 'queued' THEN ? ELSE completed_at END,
           cancel_requested = 1, updated_at = ?
         WHERE id = ? AND state IN ('queued', 'leased') RETURNING id`,
      )
      .get(now, now, jobId);
    return row !== undefined;
  }

  async retry(jobId: string): Promise<boolean> {
    const now = this.#now();
    const row = this.#db
      .prepare(
        `UPDATE gai_queue_jobs SET state = 'queued', attempts = 0, available_at = ?, completed_at = NULL,
         result = NULL, cancel_requested = 0, updated_at = ?
         WHERE id = ? AND state IN ('failed', 'cancelled') RETURNING id`,
      )
      .get(now, now, jobId);
    return row !== undefined;
  }

  async get(jobId: string): Promise<DurableQueueJob<TPayload, TResult> | undefined> {
    const row = this.#row("id", jobId);
    return row ? this.#toJob(row) : undefined;
  }

  async list(
    filter: DurableQueueListFilter = {},
  ): Promise<readonly DurableQueueJob<TPayload, TResult>[]> {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filter.name !== undefined) {
      conditions.push("name = ?");
      values.push(filter.name);
    }
    if (filter.state !== undefined) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state];
      conditions.push(`state IN (${states.map(() => "?").join(", ")})`);
      values.push(...states);
    }
    if (filter.concurrencyKey !== undefined) {
      conditions.push("concurrency_key = ?");
      values.push(filter.concurrencyKey);
    }
    if (filter.scopeId !== undefined) {
      conditions.push("scope_id = ?");
      values.push(filter.scopeId);
    }
    let limit = "";
    if (filter.limit !== undefined) {
      limit = "LIMIT ?";
      values.push(positive(filter.limit, "limit", queueInvalid));
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT * FROM gai_queue_jobs ${where} ORDER BY seq ${limit}`)
      .all(...values) as JobRow[];
    return rows.map((row) => this.#toJob(row));
  }

  async size(name?: string): Promise<number> {
    const row = this.#db
      .prepare(
        `SELECT count(*) AS count FROM gai_queue_jobs
         WHERE state IN ('queued', 'leased') AND (? IS NULL OR name = ?)`,
      )
      .get(name ?? null, name ?? null) as { count: number };
    return row.count;
  }

  async stats(): Promise<DurableQueueStats> {
    const rows = this.#db
      .prepare("SELECT state, count(*) AS count FROM gai_queue_jobs GROUP BY state")
      .all() as Array<{ state: QueueJobState; count: number }>;
    const stats = { queued: 0, leased: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      stats[row.state] = row.count;
    }
    return stats;
  }

  async reclaimExpired(): Promise<number> {
    return transaction(this.#db, () => this.#reclaim());
  }

  async purge(options: { readonly completedBefore: string | number }): Promise<number> {
    const result = this.#db
      .prepare(
        `DELETE FROM gai_queue_jobs
         WHERE state IN ('succeeded', 'failed', 'cancelled') AND completed_at < ?`,
      )
      .run(epochOf(options.completedBefore));
    return Number(result.changes);
  }

  async close(): Promise<void> {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  #reclaim(): number {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE gai_queue_jobs SET
           state = CASE WHEN cancel_requested = 1 THEN 'cancelled'
                        WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
           completed_at = CASE WHEN cancel_requested = 1 OR attempts >= max_attempts THEN ? ELSE NULL END,
           available_at = CASE WHEN cancel_requested = 1 OR attempts >= max_attempts THEN available_at ELSE ? END,
           last_error = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(now, now, LEASE_EXPIRED_MESSAGE, now, now);
    return Number(result.changes);
  }

  #row(column: "id" | "lease_id", value: string): JobRow | undefined {
    return this.#db.prepare(`SELECT * FROM gai_queue_jobs WHERE ${column} = ?`).get(value) as
      | JobRow
      | undefined;
  }

  #toJob(row: JobRow): DurableQueueJob<TPayload, TResult> {
    const metadata = parse<Readonly<Record<string, JsonValue>>>(row.metadata);
    const result = parse<TResult>(row.result);
    return {
      id: row.id,
      name: row.name,
      payload: JSON.parse(row.payload) as TPayload,
      state: row.state,
      ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
      attempts: row.attempts,
      enqueuedAt: iso(row.enqueued_at),
      availableAt: iso(row.available_at),
      updatedAt: iso(row.updated_at),
      priority: row.priority,
      maxAttempts: row.max_attempts,
      ...(row.concurrency_key === null ? {} : { concurrencyKey: row.concurrency_key }),
      ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
      ...(row.leased_by === null ? {} : { leasedBy: row.leased_by }),
      ...(row.leased_at === null ? {} : { leasedAt: iso(row.leased_at) }),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(result === undefined ? {} : { result }),
      ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at) }),
      ...(row.cancel_requested === 1 ? { cancelRequested: true } : {}),
    };
  }
}

function leaseLost(leaseId: string): DurableQueueError {
  return new DurableQueueError(
    "LEASE_LOST",
    `Lease "${leaseId}" is no longer held; the job expired, was reclaimed, or already settled.`,
  );
}

function queueInvalid(message: string): Error {
  return new DurableQueueError("INVALID_INPUT", message);
}

function runStoreInvalid(message: string): Error {
  return new RunStoreError("INVALID_INPUT", message);
}

function positive(value: number, label: string, toError: (message: string) => Error): number {
  if (!Number.isInteger(value) || value < 1) {
    throw toError(`${label} must be a positive integer.`);
  }
  return value;
}

export function createSqliteRunStore(options: SqliteDurableOptions): SqliteRunStore {
  return new SqliteRunStore(options);
}

export function createSqliteQueue<TPayload = unknown, TResult = unknown>(
  options: SqliteQueueOptions,
): SqliteQueue<TPayload, TResult> {
  return new SqliteQueue<TPayload, TResult>(options);
}
