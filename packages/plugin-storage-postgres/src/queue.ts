import { randomUUID } from "node:crypto";
import {
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
} from "@generic-ai/sdk";
import {
  isUniqueViolation,
  type PostgresPool,
  quoteIdentifier,
  toEpochMs,
  toIso,
  toJsonParam,
} from "./client.js";

export interface PostgresQueueOptions {
  /** Defaults to 3. */
  readonly maxAttempts?: number;
  /** Defaults to 30 seconds. */
  readonly leaseMs?: number;
  /** Defaults to 1s base, 60s cap, factor 2. */
  readonly backoff?: DurableQueueBackoff;
  readonly now?: () => number;
}

type JobRow = {
  id: string;
  name: string;
  payload: unknown;
  state: QueueJobState;
  scope_id: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  concurrency_key: string | null;
  idempotency_key: string | null;
  metadata: Readonly<Record<string, JsonValue>> | null;
  enqueued_at: Date;
  available_at: Date;
  updated_at: Date;
  lease_id: string | null;
  leased_by: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  result: unknown;
  completed_at: Date | null;
  cancel_requested: boolean;
};

const LEASE_EXPIRED_MESSAGE = "Lease expired before the job was acknowledged.";
const LEASE_RETRIES = 5;

/**
 * Durable job queue on Postgres. Leasing uses `FOR UPDATE SKIP LOCKED`, so
 * any number of workers in any number of processes can share one table. A
 * partial unique index guarantees at most one leased job per
 * `concurrencyKey`.
 */
export class PostgresQueue<TPayload = unknown, TResult = unknown>
  implements DurableQueueContract<TPayload, TResult>
{
  readonly kind = "queue" as const;
  readonly driver = "postgres";
  readonly durable = true as const;
  readonly #pool: PostgresPool;
  readonly #table: string;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #leaseMs: number;
  readonly #backoff: DurableQueueBackoff;

  constructor(pool: PostgresPool, schema: string, options: PostgresQueueOptions = {}) {
    this.#pool = pool;
    this.#table = `${quoteIdentifier(schema)}.queue_jobs`;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.#leaseMs = positiveInteger(options.leaseMs ?? 30_000, "leaseMs");
    this.#backoff = options.backoff ?? { baseMs: 1_000, maxMs: 60_000, factor: 2 };
  }

  async enqueue(
    input: DurableQueueEnqueueInput<TPayload>,
  ): Promise<DurableQueueJob<TPayload, TResult>> {
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw new DurableQueueError("INVALID_INPUT", "Queue jobs need a non-empty name.");
    }
    if (input.payload === undefined) {
      throw new DurableQueueError("INVALID_INPUT", "Queue job payload must not be undefined.");
    }
    const now = this.#now();
    const availableAt = input.availableAt === undefined ? now : toEpochMs(input.availableAt);
    const maxAttempts = positiveInteger(input.maxAttempts ?? this.#maxAttempts, "maxAttempts");
    const id = input.id ?? randomUUID();
    const inserted = await this.#pool.query<JobRow>(
      `INSERT INTO ${this.#table}
         (id, name, payload, state, scope_id, priority, attempts, max_attempts,
          concurrency_key, idempotency_key, metadata, enqueued_at, available_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 'queued', $4, $5, 0, $6, $7, $8, $9::jsonb, $10, $11, $10)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        id,
        input.name,
        toJsonParam(input.payload),
        input.scopeId ?? null,
        Math.trunc(input.priority ?? 0),
        maxAttempts,
        input.concurrencyKey ?? null,
        input.idempotencyKey ?? null,
        toJsonParam(input.metadata),
        new Date(now),
        new Date(availableAt),
      ],
    );
    const row = inserted.rows[0];
    if (row) {
      return this.#toJob(row);
    }
    if (input.idempotencyKey !== undefined) {
      const existing = await this.#pool.query<JobRow>(
        `SELECT * FROM ${this.#table} WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return this.#toJob(existing.rows[0]);
      }
    }
    throw new DurableQueueError("INVALID_INPUT", `A queue job with id "${id}" already exists.`);
  }

  async lease(
    options: DurableQueueLeaseOptions = {},
  ): Promise<DurableQueueLease<TPayload> | undefined> {
    const leaseMs = positiveInteger(options.leaseMs ?? this.#leaseMs, "leaseMs");
    await this.reclaimExpired();
    for (let attempt = 0; attempt < LEASE_RETRIES; attempt += 1) {
      const now = this.#now();
      try {
        const result = await this.#pool.query<JobRow>(
          `UPDATE ${this.#table} AS j SET
             state = 'leased',
             attempts = j.attempts + 1,
             lease_id = $1,
             leased_by = $2,
             leased_at = $3,
             lease_expires_at = $4,
             updated_at = $3
           WHERE j.id = (
             SELECT c.id FROM ${this.#table} AS c
             WHERE c.state = 'queued'
               AND c.available_at <= $3
               AND ($5::text[] IS NULL OR c.name = ANY($5::text[]))
               AND (
                 c.concurrency_key IS NULL OR NOT EXISTS (
                   SELECT 1 FROM ${this.#table} AS l
                   WHERE l.state = 'leased' AND l.concurrency_key = c.concurrency_key
                 )
               )
             ORDER BY c.priority DESC, c.available_at, c.seq
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           ) AND j.state = 'queued'
           RETURNING j.*`,
          [
            randomUUID(),
            options.workerId ?? null,
            new Date(now),
            new Date(now + leaseMs),
            options.names === undefined ? null : [...options.names],
          ],
        );
        const row = result.rows[0];
        return row ? (this.#toJob(row) as DurableQueueLease<TPayload>) : undefined;
      } catch (error) {
        // Another worker leased a job with the same concurrency key at the
        // same moment. Try again; the key is now visibly busy.
        if (isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  async heartbeat(leaseId: string, leaseMs?: number): Promise<boolean> {
    const now = this.#now();
    const extension = positiveInteger(leaseMs ?? this.#leaseMs, "leaseMs");
    const result = await this.#pool.query<{ cancel_requested: boolean }>(
      `UPDATE ${this.#table}
       SET lease_expires_at = $2, updated_at = $3
       WHERE lease_id = $1 AND state = 'leased'
       RETURNING cancel_requested`,
      [leaseId, new Date(now + extension), new Date(now)],
    );
    const row = result.rows[0];
    return row !== undefined && !row.cancel_requested;
  }

  async ack(leaseId: string, result?: TResult): Promise<DurableQueueJob<TPayload, TResult>> {
    const now = new Date(this.#now());
    const updated = await this.#pool.query<JobRow>(
      `UPDATE ${this.#table} SET
         state = 'succeeded',
         result = $2::jsonb,
         completed_at = $3,
         updated_at = $3,
         lease_id = NULL,
         lease_expires_at = NULL
       WHERE lease_id = $1 AND state = 'leased'
       RETURNING *`,
      [leaseId, toJsonParam(result), now],
    );
    const row = updated.rows[0];
    if (!row) {
      throw leaseLost(leaseId);
    }
    return this.#toJob(row);
  }

  async nack(
    leaseId: string,
    options: DurableQueueNackOptions = {},
  ): Promise<DurableQueueJob<TPayload, TResult>> {
    const current = await this.#pool.query<{ attempts: number }>(
      `SELECT attempts FROM ${this.#table} WHERE lease_id = $1 AND state = 'leased'`,
      [leaseId],
    );
    const attempts = current.rows[0]?.attempts;
    if (attempts === undefined) {
      throw leaseLost(leaseId);
    }
    const now = this.#now();
    const delayMs =
      options.delayMs === undefined
        ? computeQueueBackoffMs(this.#backoff, attempts)
        : Math.max(0, options.delayMs);
    const updated = await this.#pool.query<JobRow>(
      `UPDATE ${this.#table} SET
         state = CASE
           WHEN cancel_requested THEN 'cancelled'
           WHEN NOT $2::boolean OR attempts >= max_attempts THEN 'failed'
           ELSE 'queued'
         END,
         available_at = CASE
           WHEN cancel_requested OR NOT $2::boolean OR attempts >= max_attempts THEN available_at
           ELSE $4::timestamptz
         END,
         completed_at = CASE
           WHEN cancel_requested OR NOT $2::boolean OR attempts >= max_attempts THEN $5::timestamptz
           ELSE NULL
         END,
         last_error = COALESCE($3::text, last_error),
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = $5::timestamptz
       WHERE lease_id = $1 AND state = 'leased'
       RETURNING *`,
      [
        leaseId,
        options.retryable !== false,
        options.reason ?? null,
        new Date(now + delayMs),
        new Date(now),
      ],
    );
    const row = updated.rows[0];
    if (!row) {
      throw leaseLost(leaseId);
    }
    return this.#toJob(row);
  }

  async cancel(jobId: string): Promise<boolean> {
    const now = new Date(this.#now());
    const result = await this.#pool.query(
      `UPDATE ${this.#table} SET
         state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
         completed_at = CASE WHEN state = 'queued' THEN $2::timestamptz ELSE completed_at END,
         cancel_requested = true,
         updated_at = $2
       WHERE id = $1 AND state IN ('queued', 'leased')
       RETURNING id`,
      [jobId, now],
    );
    return result.rows.length > 0;
  }

  async retry(jobId: string): Promise<boolean> {
    const now = new Date(this.#now());
    const result = await this.#pool.query(
      `UPDATE ${this.#table} SET
         state = 'queued',
         attempts = 0,
         available_at = $2,
         completed_at = NULL,
         result = NULL,
         cancel_requested = false,
         updated_at = $2
       WHERE id = $1 AND state IN ('failed', 'cancelled')
       RETURNING id`,
      [jobId, now],
    );
    return result.rows.length > 0;
  }

  async get(jobId: string): Promise<DurableQueueJob<TPayload, TResult> | undefined> {
    const result = await this.#pool.query<JobRow>(`SELECT * FROM ${this.#table} WHERE id = $1`, [
      jobId,
    ]);
    const row = result.rows[0];
    return row ? this.#toJob(row) : undefined;
  }

  async list(
    filter: DurableQueueListFilter = {},
  ): Promise<readonly DurableQueueJob<TPayload, TResult>[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.name !== undefined) {
      values.push(filter.name);
      conditions.push(`name = $${values.length}`);
    }
    if (filter.state !== undefined) {
      values.push(Array.isArray(filter.state) ? [...filter.state] : [filter.state]);
      conditions.push(`state = ANY($${values.length}::text[])`);
    }
    if (filter.concurrencyKey !== undefined) {
      values.push(filter.concurrencyKey);
      conditions.push(`concurrency_key = $${values.length}`);
    }
    if (filter.scopeId !== undefined) {
      values.push(filter.scopeId);
      conditions.push(`scope_id = $${values.length}`);
    }
    let limit = "";
    if (filter.limit !== undefined) {
      values.push(positiveInteger(filter.limit, "limit"));
      limit = `LIMIT $${values.length}`;
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.#pool.query<JobRow>(
      `SELECT * FROM ${this.#table} ${where} ORDER BY seq ${limit}`,
      values,
    );
    return result.rows.map((row) => this.#toJob(row));
  }

  async size(name?: string): Promise<number> {
    const result = await this.#pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${this.#table}
       WHERE state IN ('queued', 'leased') AND ($1::text IS NULL OR name = $1)`,
      [name ?? null],
    );
    return result.rows[0]?.count ?? 0;
  }

  async stats(): Promise<DurableQueueStats> {
    const result = await this.#pool.query<{ state: QueueJobState; count: number }>(
      `SELECT state, count(*)::int AS count FROM ${this.#table} GROUP BY state`,
    );
    const stats = { queued: 0, leased: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of result.rows) {
      stats[row.state] = row.count;
    }
    return stats;
  }

  async reclaimExpired(): Promise<number> {
    const now = new Date(this.#now());
    const result = await this.#pool.query(
      `UPDATE ${this.#table} SET
         state = CASE
           WHEN cancel_requested THEN 'cancelled'
           WHEN attempts >= max_attempts THEN 'failed'
           ELSE 'queued'
         END,
         completed_at = CASE
           WHEN cancel_requested OR attempts >= max_attempts THEN $1::timestamptz
           ELSE NULL
         END,
         available_at = CASE
           WHEN cancel_requested OR attempts >= max_attempts THEN available_at
           ELSE $1::timestamptz
         END,
         last_error = $2,
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = $1
       WHERE state = 'leased' AND lease_expires_at <= $1
       RETURNING id`,
      [now, LEASE_EXPIRED_MESSAGE],
    );
    return result.rows.length;
  }

  async purge(options: { readonly completedBefore: string | number }): Promise<number> {
    const result = await this.#pool.query(
      `DELETE FROM ${this.#table}
       WHERE state IN ('succeeded', 'failed', 'cancelled') AND completed_at < $1
       RETURNING id`,
      [new Date(toEpochMs(options.completedBefore))],
    );
    return result.rows.length;
  }

  #toJob(row: JobRow): DurableQueueJob<TPayload, TResult> {
    return {
      id: row.id,
      name: row.name,
      payload: row.payload as TPayload,
      state: row.state,
      ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
      attempts: row.attempts,
      enqueuedAt: toIso(row.enqueued_at),
      availableAt: toIso(row.available_at),
      updatedAt: toIso(row.updated_at),
      priority: row.priority,
      maxAttempts: row.max_attempts,
      ...(row.concurrency_key === null ? {} : { concurrencyKey: row.concurrency_key }),
      ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
      ...(row.metadata === null ? {} : { metadata: row.metadata }),
      ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
      ...(row.leased_by === null ? {} : { leasedBy: row.leased_by }),
      ...(row.leased_at === null ? {} : { leasedAt: toIso(row.leased_at) }),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: toIso(row.lease_expires_at) }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.result === null ? {} : { result: row.result as TResult }),
      ...(row.completed_at === null ? {} : { completedAt: toIso(row.completed_at) }),
      ...(row.cancel_requested ? { cancelRequested: true } : {}),
    };
  }
}

function leaseLost(leaseId: string): DurableQueueError {
  return new DurableQueueError(
    "LEASE_LOST",
    `Lease "${leaseId}" is no longer held; the job expired, was reclaimed, or already settled.`,
  );
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DurableQueueError("INVALID_INPUT", `${label} must be a positive integer.`);
  }
  return value;
}
