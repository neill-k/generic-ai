import type { CanonicalEvent } from "../events/taxonomy.js";
import type { RunEnvelope, RunEnvelopeStatus } from "../run-envelope/index.js";
import type { Awaitable, JsonValue } from "./shared.js";

/**
 * Durable run store contract.
 *
 * A run store persists the three things a restarted process needs to pick a
 * run back up: the run envelope (status and output), the sessions that ran
 * inside it (with opaque runtime state), and the run's canonical event log.
 * Event logs are append-only and ordered by the canonical event `sequence`.
 */
export interface RunRecord<TOutput = unknown> {
  readonly runId: string;
  readonly envelope: RunEnvelope<TOutput>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Monotonic record version, starting at 1. Used for optimistic concurrency. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveRunInput<TOutput = unknown> {
  readonly envelope: RunEnvelope<TOutput>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /**
   * When set, the write only succeeds if the stored record has this version.
   * Use `0` to require that the run does not exist yet.
   */
  readonly expectedVersion?: number;
}

export interface RunListFilter {
  readonly status?: RunEnvelopeStatus | readonly RunEnvelopeStatus[];
  readonly rootScopeId?: string;
  /** Only runs created strictly before this ISO timestamp (for paging). */
  readonly createdBefore?: string;
  readonly limit?: number;
}

export type SessionRecordStatus = "active" | "succeeded" | "failed" | "cancelled";

export interface SessionRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly parentSessionId?: string;
  readonly agentId?: string;
  readonly status: SessionRecordStatus;
  /** Opaque, serializable runtime state (for example a pi session transcript). */
  readonly state?: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveSessionInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly parentSessionId?: string;
  readonly agentId?: string;
  readonly status: SessionRecordStatus;
  readonly state?: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly expectedVersion?: number;
}

export interface AppendEventsResult {
  /** Number of events newly written (idempotent re-appends are not counted). */
  readonly appended: number;
  /** Highest stored sequence for the run after the append, or 0 if empty. */
  readonly lastSequence: number;
}

export interface ReadEventsOptions {
  /** Inclusive lower bound on `sequence`. */
  readonly fromSequence?: number;
  readonly limit?: number;
}

export type RunStoreErrorCode =
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "SEQUENCE_CONFLICT"
  | "INVALID_INPUT"
  | "CLOSED";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;

  constructor(code: RunStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunStoreError";
    this.code = code;
  }
}

export function isRunStoreError(error: unknown, code?: RunStoreErrorCode): error is RunStoreError {
  return (
    error instanceof Error &&
    error.name === "RunStoreError" &&
    (code === undefined || (error as RunStoreError).code === code)
  );
}

export interface RunStoreContract {
  readonly kind: "run-store";
  readonly driver: string;

  saveRun<TOutput = unknown>(input: SaveRunInput<TOutput>): Awaitable<RunRecord<TOutput>>;
  getRun<TOutput = unknown>(runId: string): Awaitable<RunRecord<TOutput> | undefined>;
  listRuns(filter?: RunListFilter): Awaitable<readonly RunRecord[]>;
  /** Deletes the run, its sessions, and its event log. */
  deleteRun(runId: string): Awaitable<boolean>;

  saveSession(input: SaveSessionInput): Awaitable<SessionRecord>;
  getSession(sessionId: string): Awaitable<SessionRecord | undefined>;
  listSessions(runId: string): Awaitable<readonly SessionRecord[]>;

  /**
   * Appends canonical events to a run's log. Appends are idempotent per
   * `(runId, sequence)` when the `eventId` matches; a different event at an
   * existing sequence fails with `SEQUENCE_CONFLICT`. All events must carry
   * the given `runId`.
   */
  appendEvents(runId: string, events: readonly CanonicalEvent[]): Awaitable<AppendEventsResult>;
  readEvents(runId: string, options?: ReadEventsOptions): Awaitable<readonly CanonicalEvent[]>;
  lastSequence(runId: string): Awaitable<number>;

  close?(): Awaitable<void>;
}
