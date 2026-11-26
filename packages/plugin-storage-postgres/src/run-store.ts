import {
  type AppendEventsResult,
  type CanonicalEvent,
  type JsonValue,
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
import {
  type PostgresPool,
  quoteIdentifier,
  toIso,
  toJsonParam,
  withTransaction,
} from "./client.js";

type RunRow = {
  run_id: string;
  envelope: RunEnvelope;
  metadata: Readonly<Record<string, JsonValue>> | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type SessionRow = {
  session_id: string;
  run_id: string;
  parent_session_id: string | null;
  agent_id: string | null;
  status: SessionRecordStatus;
  state: JsonValue | null;
  metadata: Readonly<Record<string, JsonValue>> | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export interface PostgresRunStoreOptions {
  readonly now?: () => number;
}

/**
 * `RunStoreContract` on Postgres. Runs, sessions and events live in separate
 * tables without foreign keys, so events may be appended before a run
 * record is written.
 */
export class PostgresRunStore implements RunStoreContract {
  readonly kind = "run-store" as const;
  readonly driver = "postgres";
  readonly #pool: PostgresPool;
  readonly #now: () => number;
  readonly #runs: string;
  readonly #sessions: string;
  readonly #events: string;

  constructor(pool: PostgresPool, schema: string, options: PostgresRunStoreOptions = {}) {
    this.#pool = pool;
    this.#now = options.now ?? Date.now;
    const s = quoteIdentifier(schema);
    this.#runs = `${s}.runs`;
    this.#sessions = `${s}.run_sessions`;
    this.#events = `${s}.run_events`;
  }

  async saveRun<TOutput = unknown>(input: SaveRunInput<TOutput>): Promise<RunRecord<TOutput>> {
    const envelope = input.envelope;
    if (typeof envelope?.runId !== "string" || envelope.runId.length === 0) {
      throw new RunStoreError("INVALID_INPUT", "Run envelope must carry a runId.");
    }
    const now = new Date(this.#now());
    const params = [
      envelope.runId,
      envelope.rootScopeId,
      envelope.status,
      toJsonParam(envelope),
      toJsonParam(input.metadata),
      now,
    ];
    let rows: RunRow[];
    if (input.expectedVersion === undefined) {
      rows = (
        await this.#pool.query<RunRow>(
          `INSERT INTO ${this.#runs}
             (run_id, root_scope_id, status, envelope, metadata, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1, $6, $6)
           ON CONFLICT (run_id) DO UPDATE SET
             root_scope_id = EXCLUDED.root_scope_id,
             status = EXCLUDED.status,
             envelope = EXCLUDED.envelope,
             metadata = COALESCE(EXCLUDED.metadata, ${this.#runs}.metadata),
             version = ${this.#runs}.version + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          params,
        )
      ).rows;
    } else if (input.expectedVersion === 0) {
      rows = (
        await this.#pool.query<RunRow>(
          `INSERT INTO ${this.#runs}
             (run_id, root_scope_id, status, envelope, metadata, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 1, $6, $6)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *`,
          params,
        )
      ).rows;
    } else {
      rows = (
        await this.#pool.query<RunRow>(
          `UPDATE ${this.#runs} SET
             root_scope_id = $2, status = $3, envelope = $4::jsonb,
             metadata = COALESCE($5::jsonb, metadata),
             version = version + 1, updated_at = $6
           WHERE run_id = $1 AND version = $7
           RETURNING *`,
          [...params, input.expectedVersion],
        )
      ).rows;
    }
    const row = rows[0];
    if (!row) {
      throw new RunStoreError(
        "VERSION_CONFLICT",
        `Run "${envelope.runId}" is not at expected version ${input.expectedVersion}.`,
      );
    }
    return toRunRecord<TOutput>(row);
  }

  async getRun<TOutput = unknown>(runId: string): Promise<RunRecord<TOutput> | undefined> {
    const result = await this.#pool.query<RunRow>(`SELECT * FROM ${this.#runs} WHERE run_id = $1`, [
      runId,
    ]);
    const row = result.rows[0];
    return row ? toRunRecord<TOutput>(row) : undefined;
  }

  async listRuns(filter: RunListFilter = {}): Promise<readonly RunRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.status !== undefined) {
      values.push(Array.isArray(filter.status) ? [...filter.status] : [filter.status]);
      conditions.push(`status = ANY($${values.length}::text[])`);
    }
    if (filter.rootScopeId !== undefined) {
      values.push(filter.rootScopeId);
      conditions.push(`root_scope_id = $${values.length}`);
    }
    if (filter.createdBefore !== undefined) {
      values.push(new Date(filter.createdBefore));
      conditions.push(`created_at < $${values.length}`);
    }
    let limit = "";
    if (filter.limit !== undefined) {
      values.push(positiveLimit(filter.limit));
      limit = `LIMIT $${values.length}`;
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const result = await this.#pool.query<RunRow>(
      `SELECT * FROM ${this.#runs} ${where} ORDER BY created_at DESC, run_id DESC ${limit}`,
      values,
    );
    return result.rows.map((row) => toRunRecord(row));
  }

  async deleteRun(runId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `WITH deleted_events AS (DELETE FROM ${this.#events} WHERE run_id = $1),
            deleted_sessions AS (DELETE FROM ${this.#sessions} WHERE run_id = $1)
       DELETE FROM ${this.#runs} WHERE run_id = $1 RETURNING run_id`,
      [runId],
    );
    return result.rows.length > 0;
  }

  async saveSession(input: SaveSessionInput): Promise<SessionRecord> {
    if (input.sessionId.length === 0 || input.runId.length === 0) {
      throw new RunStoreError("INVALID_INPUT", "Sessions need a sessionId and a runId.");
    }
    const now = new Date(this.#now());
    const params = [
      input.sessionId,
      input.runId,
      input.parentSessionId ?? null,
      input.agentId ?? null,
      input.status,
      toJsonParam(input.state),
      toJsonParam(input.metadata),
      now,
    ];
    const insert = `INSERT INTO ${this.#sessions}
      (session_id, run_id, parent_session_id, agent_id, status, state, metadata, version, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 1, $8, $8)`;
    let rows: SessionRow[];
    if (input.expectedVersion === undefined) {
      rows = (
        await this.#pool.query<SessionRow>(
          `${insert}
           ON CONFLICT (session_id) DO UPDATE SET
             run_id = EXCLUDED.run_id,
             parent_session_id = EXCLUDED.parent_session_id,
             agent_id = EXCLUDED.agent_id,
             status = EXCLUDED.status,
             state = EXCLUDED.state,
             metadata = COALESCE(EXCLUDED.metadata, ${this.#sessions}.metadata),
             version = ${this.#sessions}.version + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          params,
        )
      ).rows;
    } else if (input.expectedVersion === 0) {
      rows = (
        await this.#pool.query<SessionRow>(
          `${insert} ON CONFLICT (session_id) DO NOTHING RETURNING *`,
          params,
        )
      ).rows;
    } else {
      rows = (
        await this.#pool.query<SessionRow>(
          `UPDATE ${this.#sessions} SET
             run_id = $2, parent_session_id = $3, agent_id = $4, status = $5,
             state = $6::jsonb, metadata = COALESCE($7::jsonb, metadata),
             version = version + 1, updated_at = $8
           WHERE session_id = $1 AND version = $9
           RETURNING *`,
          [...params, input.expectedVersion],
        )
      ).rows;
    }
    const row = rows[0];
    if (!row) {
      throw new RunStoreError(
        "VERSION_CONFLICT",
        `Session "${input.sessionId}" is not at expected version ${input.expectedVersion}.`,
      );
    }
    return toSessionRecord(row);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const result = await this.#pool.query<SessionRow>(
      `SELECT * FROM ${this.#sessions} WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row ? toSessionRecord(row) : undefined;
  }

  async listSessions(runId: string): Promise<readonly SessionRecord[]> {
    const result = await this.#pool.query<SessionRow>(
      `SELECT * FROM ${this.#sessions} WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return result.rows.map(toSessionRecord);
  }

  async appendEvents(
    runId: string,
    events: readonly CanonicalEvent[],
  ): Promise<AppendEventsResult> {
    validateEvents(runId, events);
    if (events.length === 0) {
      return { appended: 0, lastSequence: await this.lastSequence(runId) };
    }
    return withTransaction(this.#pool, async (client) => {
      const sequences = events.map((event) => event.sequence);
      const inserted = await client.query<{ sequence: string }>(
        `INSERT INTO ${this.#events}
           (run_id, sequence, event_id, name, session_id, occurred_at, event)
         SELECT $1, t.sequence, t.event_id, t.name, t.session_id, t.occurred_at, t.event
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[])
           AS t(sequence, event_id, name, session_id, occurred_at, event)
         ON CONFLICT (run_id, sequence) DO NOTHING
         RETURNING sequence`,
        [
          runId,
          sequences,
          events.map((event) => event.eventId),
          events.map((event) => event.name),
          events.map((event) => event.sessionId),
          events.map((event) => event.occurredAt),
          events.map((event) => JSON.stringify(event)),
        ],
      );
      const appended = new Set(inserted.rows.map((row) => Number(row.sequence)));
      const skipped = events.filter((event) => !appended.has(event.sequence));
      if (skipped.length > 0) {
        const existing = await client.query<{ sequence: string; event_id: string }>(
          `SELECT sequence, event_id FROM ${this.#events}
           WHERE run_id = $1 AND sequence = ANY($2::bigint[])`,
          [runId, skipped.map((event) => event.sequence)],
        );
        const stored = new Map(existing.rows.map((row) => [Number(row.sequence), row.event_id]));
        for (const event of skipped) {
          if (stored.get(event.sequence) !== event.eventId) {
            throw new RunStoreError(
              "SEQUENCE_CONFLICT",
              `Run "${runId}" already has a different event at sequence ${event.sequence}.`,
            );
          }
        }
      }
      const last = await client.query<{ last: string | null }>(
        `SELECT max(sequence) AS last FROM ${this.#events} WHERE run_id = $1`,
        [runId],
      );
      return { appended: appended.size, lastSequence: Number(last.rows[0]?.last ?? 0) };
    });
  }

  async readEvents(
    runId: string,
    options: ReadEventsOptions = {},
  ): Promise<readonly CanonicalEvent[]> {
    const values: unknown[] = [runId, options.fromSequence ?? 0];
    let limit = "";
    if (options.limit !== undefined) {
      values.push(positiveLimit(options.limit));
      limit = "LIMIT $3";
    }
    const result = await this.#pool.query<{ event: CanonicalEvent }>(
      `SELECT event FROM ${this.#events}
       WHERE run_id = $1 AND sequence >= $2
       ORDER BY sequence ${limit}`,
      values,
    );
    return result.rows.map((row) => row.event);
  }

  async lastSequence(runId: string): Promise<number> {
    const result = await this.#pool.query<{ last: string | null }>(
      `SELECT max(sequence) AS last FROM ${this.#events} WHERE run_id = $1`,
      [runId],
    );
    return Number(result.rows[0]?.last ?? 0);
  }
}

export function validateEvents(runId: string, events: readonly CanonicalEvent[]): void {
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
}

function positiveLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RunStoreError("INVALID_INPUT", "limit must be a positive integer.");
  }
  return limit;
}

function toRunRecord<TOutput>(row: RunRow): RunRecord<TOutput> {
  return {
    runId: row.run_id,
    envelope: row.envelope as RunEnvelope<TOutput>,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    status: row.status,
    ...(row.state === null ? {} : { state: row.state }),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
