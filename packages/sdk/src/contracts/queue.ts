import type { Awaitable, JsonValue } from "./shared.js";

export type QueueJobState = "queued" | "leased" | "succeeded" | "failed" | "cancelled";

export interface QueueJob<TPayload = unknown> {
  readonly id: string;
  readonly name: string;
  readonly payload: TPayload;
  readonly state: QueueJobState;
  readonly scopeId?: string;
  readonly attempts: number;
  readonly enqueuedAt: string;
  readonly availableAt?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface QueueLease<TPayload = unknown> extends QueueJob<TPayload> {
  readonly state: "leased";
  readonly leaseId: string;
  readonly leasedAt: string;
}

export interface QueueContract<TPayload = unknown, TResult = unknown> {
  readonly kind: "queue";
  readonly driver: string;
  enqueue(
    job: Omit<QueueJob<TPayload>, "state" | "attempts"> &
      Partial<Pick<QueueJob<TPayload>, "state" | "attempts">>,
  ): Awaitable<QueueJob<TPayload>>;
  lease(name?: string): Awaitable<QueueLease<TPayload> | undefined>;
  ack(leaseId: string, result?: TResult): Awaitable<void>;
  nack(leaseId: string, reason?: string): Awaitable<void>;
  cancel(jobId: string): Awaitable<boolean>;
  size(name?: string): Awaitable<number>;
}

/**
 * Durable queue contract.
 *
 * Extends the base queue with what production workers need: time-bounded
 * leases that expire when a worker dies, heartbeats, retries with backoff,
 * a dead-letter state (`failed` after the last attempt), per-key concurrency
 * (for example one running task per agent), idempotent enqueue, and
 * cancellation that a running worker can observe.
 */
export interface DurableQueueEnqueueInput<TPayload = unknown> {
  readonly id?: string;
  readonly name: string;
  readonly payload: TPayload;
  readonly scopeId?: string;
  /** Higher runs first among available jobs. Defaults to 0. */
  readonly priority?: number;
  /** ISO timestamp or epoch milliseconds before which the job is not leased. */
  readonly availableAt?: string | number;
  /** Total attempts before the job is dead-lettered. Defaults to the queue default. */
  readonly maxAttempts?: number;
  /** At most one job per key is leased at a time. */
  readonly concurrencyKey?: string;
  /**
   * Deduplicates enqueues: while a job with the same key exists, enqueue
   * returns that job instead of creating another.
   */
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface DurableQueueJob<TPayload = unknown, TResult = unknown> extends QueueJob<TPayload> {
  readonly priority: number;
  readonly maxAttempts: number;
  readonly concurrencyKey?: string;
  readonly idempotencyKey?: string;
  readonly availableAt: string;
  readonly updatedAt: string;
  readonly leaseId?: string;
  readonly leasedBy?: string;
  readonly leasedAt?: string;
  readonly leaseExpiresAt?: string;
  readonly lastError?: string;
  readonly result?: TResult;
  readonly completedAt?: string;
  readonly cancelRequested?: boolean;
}

export interface DurableQueueLease<TPayload = unknown> extends QueueLease<TPayload> {
  readonly priority: number;
  readonly maxAttempts: number;
  readonly concurrencyKey?: string;
  readonly leasedBy?: string;
  readonly leaseExpiresAt: string;
}

export interface DurableQueueLeaseOptions {
  /** Only lease jobs with one of these names. */
  readonly names?: readonly string[];
  /** Lease duration. Defaults to the queue default. */
  readonly leaseMs?: number;
  /** Identifies the worker holding the lease, for operators. */
  readonly workerId?: string;
}

export interface DurableQueueNackOptions {
  readonly reason?: string;
  /** `false` dead-letters immediately regardless of remaining attempts. */
  readonly retryable?: boolean;
  /** Overrides the computed backoff delay. */
  readonly delayMs?: number;
}

export interface DurableQueueListFilter {
  readonly name?: string;
  readonly state?: QueueJobState | readonly QueueJobState[];
  readonly concurrencyKey?: string;
  readonly scopeId?: string;
  readonly limit?: number;
}

export interface DurableQueueBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Multiplies the delay per attempt. Defaults to 2. */
  readonly factor?: number;
}

export interface DurableQueueStats {
  readonly queued: number;
  readonly leased: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

export type DurableQueueErrorCode = "LEASE_LOST" | "NOT_FOUND" | "INVALID_INPUT" | "CLOSED";

export class DurableQueueError extends Error {
  readonly code: DurableQueueErrorCode;

  constructor(code: DurableQueueErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableQueueError";
    this.code = code;
  }
}

export function isDurableQueueError(
  error: unknown,
  code?: DurableQueueErrorCode,
): error is DurableQueueError {
  return (
    error instanceof Error &&
    error.name === "DurableQueueError" &&
    (code === undefined || (error as DurableQueueError).code === code)
  );
}

export interface DurableQueueContract<TPayload = unknown, TResult = unknown> {
  readonly kind: "queue";
  readonly driver: string;
  readonly durable: true;

  enqueue(input: DurableQueueEnqueueInput<TPayload>): Awaitable<DurableQueueJob<TPayload, TResult>>;
  /**
   * Leases the next available job. Expired leases are reclaimed first, so a
   * job held by a crashed worker becomes available again once its lease ends.
   */
  lease(options?: DurableQueueLeaseOptions): Awaitable<DurableQueueLease<TPayload> | undefined>;
  /** Extends a lease. Returns `false` when the lease was lost or cancellation was requested. */
  heartbeat(leaseId: string, leaseMs?: number): Awaitable<boolean>;
  /** Completes a leased job. Throws `LEASE_LOST` when the lease is no longer held. */
  ack(leaseId: string, result?: TResult): Awaitable<DurableQueueJob<TPayload, TResult>>;
  /**
   * Fails a leased attempt. The job is retried after backoff while attempts
   * remain, otherwise it moves to `failed` (the dead-letter state).
   * Throws `LEASE_LOST` when the lease is no longer held.
   */
  nack(
    leaseId: string,
    options?: DurableQueueNackOptions,
  ): Awaitable<DurableQueueJob<TPayload, TResult>>;
  /**
   * Cancels a job. Queued jobs become `cancelled` immediately; leased jobs are
   * flagged so the worker's next heartbeat returns `false`, then become
   * `cancelled` when the worker settles them. Returns `false` for unknown or
   * already-terminal jobs.
   */
  cancel(jobId: string): Awaitable<boolean>;
  /** Moves a `failed` or `cancelled` job back to `queued` with fresh attempts. */
  retry(jobId: string): Awaitable<boolean>;
  get(jobId: string): Awaitable<DurableQueueJob<TPayload, TResult> | undefined>;
  list(filter?: DurableQueueListFilter): Awaitable<readonly DurableQueueJob<TPayload, TResult>[]>;
  /** Count of queued plus leased jobs, optionally for one job name. */
  size(name?: string): Awaitable<number>;
  stats(): Awaitable<DurableQueueStats>;
  /** Returns expired leases to `queued` (or `failed` when out of attempts). */
  reclaimExpired(): Awaitable<number>;
  /** Deletes terminal jobs completed before the given time. */
  purge(options: { readonly completedBefore: string | number }): Awaitable<number>;
  close?(): Awaitable<void>;
}

/** Exponential backoff delay for the given attempt number (1-based). */
export function computeQueueBackoffMs(backoff: DurableQueueBackoff, attempt: number): number {
  const factor = backoff.factor ?? 2;
  const exponent = Math.max(0, attempt - 1);
  const raw = backoff.baseMs * factor ** exponent;
  return Math.min(backoff.maxMs, Math.max(0, Math.round(raw)));
}
