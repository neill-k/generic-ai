import type {
  DurableQueueContract,
  DurableQueueJob,
  DurableQueueLease,
} from "../contracts/queue.js";
import { isDurableQueueError } from "../contracts/queue.js";

export interface QueueWorkerJobContext {
  /** Aborted when the job is cancelled, its lease is lost, or the worker stops. */
  readonly signal: AbortSignal;
  readonly workerId: string;
  /** Extends the lease now. Returns `false` if the job should stop. */
  heartbeat(): Promise<boolean>;
}

export type QueueWorkerHandler<TPayload, TResult> = (
  job: DurableQueueLease<TPayload>,
  context: QueueWorkerJobContext,
) => Promise<TResult> | TResult;

export type QueueWorkerEvent<TPayload, TResult> =
  | { readonly type: "leased"; readonly job: DurableQueueLease<TPayload> }
  | { readonly type: "succeeded"; readonly job: DurableQueueJob<TPayload, TResult> }
  | {
      readonly type: "retrying" | "dead-lettered" | "cancelled";
      readonly job: DurableQueueJob<TPayload, TResult>;
      readonly error?: unknown;
    }
  | {
      readonly type: "lease-lost";
      readonly job: DurableQueueLease<TPayload>;
      readonly error?: unknown;
    }
  | { readonly type: "error"; readonly error: unknown; readonly job?: DurableQueueLease<TPayload> };

export interface QueueWorkerOptions<TPayload, TResult> {
  /** Jobs run at the same time by this worker. Defaults to 1. */
  readonly concurrency?: number;
  readonly names?: readonly string[];
  readonly workerId?: string;
  /** Lease length. Defaults to 30 seconds. */
  readonly leaseMs?: number;
  /** Heartbeat interval. Defaults to a third of `leaseMs`. */
  readonly heartbeatMs?: number;
  /** Idle poll interval. Defaults to 1 second. */
  readonly pollIntervalMs?: number;
  /** How long `stop()` waits for running jobs before aborting them. Defaults to 30 seconds. */
  readonly drainTimeoutMs?: number;
  readonly onEvent?: (event: QueueWorkerEvent<TPayload, TResult>) => void;
}

export interface QueueWorker {
  readonly workerId: string;
  readonly running: boolean;
  readonly active: number;
  start(): void;
  /** Polls immediately instead of waiting for the next interval. */
  wake(): void;
  /** Stops leasing, waits for running jobs (up to `drainTimeoutMs`), then aborts the rest. */
  stop(): Promise<void>;
}

/**
 * Error a handler can throw to dead-letter a job without further retries.
 */
export class NonRetryableJobError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableJobError";
  }
}

let workerCounter = 0;

export function createQueueWorker<TPayload, TResult>(
  queue: DurableQueueContract<TPayload, TResult>,
  handler: QueueWorkerHandler<TPayload, TResult>,
  options: QueueWorkerOptions<TPayload, TResult> = {},
): QueueWorker {
  const concurrency = positiveInteger(options.concurrency ?? 1, "concurrency");
  const leaseMs = positiveInteger(options.leaseMs ?? 30_000, "leaseMs");
  const heartbeatMs = positiveInteger(
    options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)),
    "heartbeatMs",
  );
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? 30_000);
  workerCounter += 1;
  const workerId = options.workerId ?? `worker-${process.pid}-${workerCounter}`;

  const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let running = false;
  let polling = false;
  let pollAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = (event: QueueWorkerEvent<TPayload, TResult>) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers must not break the worker loop.
    }
  };

  const schedule = (delayMs: number) => {
    if (!running) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delayMs);
  };

  async function poll(): Promise<void> {
    if (!running) {
      return;
    }
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    let leasedAny = false;
    try {
      while (running && inFlight.size < concurrency) {
        const lease = await queue.lease({
          leaseMs,
          workerId,
          ...(options.names === undefined ? {} : { names: options.names }),
        });
        if (lease === undefined) {
          break;
        }
        leasedAny = true;
        if (!running) {
          // Stopped while leasing: hand the job straight back.
          await safeNack(lease, "worker stopped before start", 0);
          break;
        }
        startJob(lease);
      }
    } catch (error) {
      emit({ type: "error", error });
    } finally {
      polling = false;
    }

    if (pollAgain) {
      pollAgain = false;
      schedule(0);
    } else if (inFlight.size < concurrency) {
      schedule(leasedAny ? 0 : pollIntervalMs);
    }
  }

  async function safeNack(lease: DurableQueueLease<TPayload>, reason: string, delayMs?: number) {
    try {
      return await queue.nack(lease.leaseId, {
        reason,
        ...(delayMs === undefined ? {} : { delayMs }),
      });
    } catch (error) {
      if (isDurableQueueError(error, "LEASE_LOST")) {
        emit({ type: "lease-lost", job: lease, error });
        return undefined;
      }
      emit({ type: "error", error, job: lease });
      return undefined;
    }
  }

  function startJob(lease: DurableQueueLease<TPayload>): void {
    const controller = new AbortController();
    emit({ type: "leased", job: lease });

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const heartbeat = async (): Promise<boolean> => {
      if (controller.signal.aborted) {
        return false;
      }
      try {
        const ok = await queue.heartbeat(lease.leaseId, leaseMs);
        if (!ok && !controller.signal.aborted) {
          controller.abort(new Error("Job lease lost or cancellation requested."));
        }
        return ok;
      } catch (error) {
        emit({ type: "error", error, job: lease });
        return !controller.signal.aborted;
      }
    };
    heartbeatTimer = setInterval(() => {
      void heartbeat();
    }, heartbeatMs);

    const done = (async () => {
      try {
        const result = await handler(lease, {
          signal: controller.signal,
          workerId,
          heartbeat,
        });
        try {
          const job = await queue.ack(lease.leaseId, result);
          emit({ type: "succeeded", job });
        } catch (error) {
          if (isDurableQueueError(error, "LEASE_LOST")) {
            emit({ type: "lease-lost", job: lease, error });
          } else {
            emit({ type: "error", error, job: lease });
          }
        }
      } catch (error) {
        const retryable = !(
          typeof error === "object" &&
          error !== null &&
          (error as { retryable?: unknown }).retryable === false
        );
        try {
          const job = await queue.nack(lease.leaseId, {
            reason: describeError(error),
            retryable,
          });
          const type =
            job.state === "queued"
              ? "retrying"
              : job.state === "cancelled"
                ? "cancelled"
                : "dead-lettered";
          emit({ type, job, error });
        } catch (nackError) {
          if (isDurableQueueError(nackError, "LEASE_LOST")) {
            emit({ type: "lease-lost", job: lease, error });
          } else {
            emit({ type: "error", error: nackError, job: lease });
          }
        }
      } finally {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        inFlight.delete(lease.leaseId);
        if (running) {
          schedule(0);
        }
      }
    })();

    inFlight.set(lease.leaseId, { controller, done });
  }

  return {
    get workerId() {
      return workerId;
    },
    get running() {
      return running;
    },
    get active() {
      return inFlight.size;
    },
    start() {
      if (running) {
        return;
      }
      running = true;
      schedule(0);
    },
    wake() {
      if (running) {
        schedule(0);
      }
    },
    async stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const pending = [...inFlight.values()];
      if (pending.length === 0) {
        return;
      }
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        drainTimer = setTimeout(() => resolve("timeout"), drainTimeoutMs);
      });
      const outcome = await Promise.race([
        Promise.all(pending.map((entry) => entry.done)).then(() => "drained" as const),
        timedOut,
      ]);
      clearTimeout(drainTimer);
      if (outcome === "timeout") {
        const remaining = [...inFlight.values()];
        for (const entry of remaining) {
          entry.controller.abort(new Error("Queue worker stopped."));
        }
        // Give aborted handlers one more drain window to settle their leases.
        // Handlers that ignore the signal keep their lease until it expires,
        // after which another worker reclaims the job.
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(remaining.map((entry) => entry.done)),
          new Promise<void>((resolve) => {
            abortTimer = setTimeout(resolve, drainTimeoutMs);
          }),
        ]);
        clearTimeout(abortTimer);
      }
    },
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`Queue worker ${label} must be a positive integer.`);
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === "string" ? error : "Job handler failed.";
}
