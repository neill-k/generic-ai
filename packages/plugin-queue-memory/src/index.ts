import { EventEmitter } from "node:events";

export const name = "@generic-ai/plugin-queue-memory" as const;
export const kind = "queue" as const;

type Awaitable<T> = T | PromiseLike<T>;

export interface QueueJob<TPayload> {
  readonly id?: string;
  readonly name?: string;
  readonly payload: TPayload;
  readonly priority?: number;
  readonly runAt?: number | Date;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface QueueJobSnapshot<TPayload> {
  readonly id: string;
  readonly name?: string;
  readonly payload: TPayload;
  readonly priority: number;
  readonly runAt: number;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface QueueContext<TPayload, TResult> {
  readonly queue: InMemoryQueue<TPayload, TResult>;
  readonly jobId: string;
  readonly enqueuedAt: number;
  readonly startedAt: number;
  readonly sequence: number;
  readonly signal?: AbortSignal;
}

export type QueueTask<TPayload, TResult> = (
  job: Readonly<QueueJobSnapshot<TPayload>>,
  context: Readonly<QueueContext<TPayload, TResult>>,
) => Awaitable<TResult>;

export interface QueueState {
  readonly pending: number;
  readonly running: number;
  readonly paused: boolean;
  readonly closed: boolean;
  readonly concurrency: number;
}

export interface QueueEventMap<TPayload, TResult> {
  readonly enqueued: [job: QueueJobSnapshot<TPayload>];
  readonly started: [
    job: QueueJobSnapshot<TPayload>,
    context: QueueContext<TPayload, TResult>,
  ];
  readonly completed: [job: QueueJobSnapshot<TPayload>, result: TResult];
  readonly failed: [job: QueueJobSnapshot<TPayload>, error: unknown];
  readonly paused: [state: QueueState];
  readonly resumed: [state: QueueState];
  readonly drained: [state: QueueState];
  readonly closed: [state: QueueState];
  readonly cleared: [count: number];
}

export interface QueueOptions {
  readonly concurrency?: number;
  readonly maxPending?: number;
  readonly now?: () => number;
}

export interface QueueCloseOptions {
  readonly drain?: boolean;
}

export interface QueueMemoryPlugin<TPayload, TResult>
  extends InMemoryQueue<TPayload, TResult> {
  readonly name: typeof name;
  readonly kind: typeof kind;
}

export class QueueClosedError extends Error {
  constructor() {
    super("The in-memory queue is closed.");
    this.name = "QueueClosedError";
  }
}

export class QueueCapacityError extends Error {
  constructor(maxPending: number) {
    super(`The in-memory queue has reached its pending limit of ${maxPending}.`);
    this.name = "QueueCapacityError";
  }
}

export class QueueAbortError extends Error {
  constructor(message = "The queue job was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

interface QueueEntry<TPayload, TResult> {
  readonly snapshot: QueueJobSnapshot<TPayload>;
  signal?: AbortSignal;
  readonly resolve: (value: TResult | PromiseLike<TResult>) => void;
  readonly reject: (reason?: unknown) => void;
  cleanupAbort?: () => void;
}

type QueueSnapshotInit<TPayload> = {
  id: string;
  payload: TPayload;
  priority: number;
  runAt: number;
  enqueuedAt: number;
  sequence: number;
  name?: string;
  metadata?: Readonly<Record<string, unknown>>;
};

type QueueContextInit<TPayload, TResult> = {
  queue: InMemoryQueue<TPayload, TResult>;
  jobId: string;
  enqueuedAt: number;
  startedAt: number;
  sequence: number;
  signal?: AbortSignal;
};
type QueueEventName<TPayload, TResult> = keyof QueueEventMap<TPayload, TResult>;
type QueueEventListener<
  TPayload,
  TResult,
  TEventName extends QueueEventName<TPayload, TResult>,
> = (...args: QueueEventMap<TPayload, TResult>[TEventName]) => void;

function normalizeRunAt(runAt: number | Date | undefined): number {
  if (runAt === undefined) {
    // Immediate jobs share a sentinel timestamp so priority and FIFO
    // ordering are not perturbed by sub-millisecond enqueue timing.
    return 0;
  }

  const normalized = runAt instanceof Date ? runAt.getTime() : runAt;

  if (!Number.isFinite(normalized)) {
    throw new TypeError("Queue jobs must use a finite `runAt` value when provided.");
  }

  return normalized;
}

function normalizePriority(priority: number | undefined): number {
  if (priority === undefined) {
    return 0;
  }

  if (!Number.isFinite(priority)) {
    throw new TypeError("Queue job priority must be a finite number when provided.");
  }

  return priority;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(limit) || limit < 1 || !Number.isInteger(limit)) {
    throw new TypeError("Queue limits must be positive integers when provided.");
  }

  return limit;
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  if (typeof reason === "string" && reason.length > 0) {
    return new QueueAbortError(reason);
  }

  return new QueueAbortError();
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}

export class InMemoryQueue<TPayload, TResult> {
  readonly name = name;
  readonly kind = kind;

  #events = new EventEmitter();
  #handler: QueueTask<TPayload, TResult>;
  #now: () => number;
  #concurrency: number;
  #maxPending: number;
  #pending: Array<QueueEntry<TPayload, TResult>> = [];
  #running = 0;
  #sequence = 0;
  #paused = false;
  #closing = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #immediate: ReturnType<typeof setImmediate> | null = null;
  #idleWaiters: Array<() => void> = [];
  #closePromise: Promise<void> | null = null;

  constructor(handler: QueueTask<TPayload, TResult>, options: QueueOptions = {}) {
    if (typeof handler !== "function") {
      throw new TypeError("A queue handler function is required.");
    }

    this.#handler = handler;
    this.#now = options.now ?? Date.now;
    this.#concurrency = normalizeLimit(options.concurrency ?? 1);
    this.#maxPending = normalizeLimit(options.maxPending);
  }

  get paused(): boolean {
    return this.#paused;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closing(): boolean {
    return this.#closing;
  }

  get state(): QueueState {
    return {
      pending: this.#pending.length,
      running: this.#running,
      paused: this.#paused,
      closed: this.#closed,
      concurrency: this.#concurrency,
    };
  }

  on<TEventName extends QueueEventName<TPayload, TResult>>(
    eventName: TEventName,
    listener: QueueEventListener<TPayload, TResult, TEventName>,
  ): this {
    this.#events.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  once<TEventName extends QueueEventName<TPayload, TResult>>(
    eventName: TEventName,
    listener: QueueEventListener<TPayload, TResult, TEventName>,
  ): this {
    this.#events.once(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  off<TEventName extends QueueEventName<TPayload, TResult>>(
    eventName: TEventName,
    listener: QueueEventListener<TPayload, TResult, TEventName>,
  ): this {
    this.#events.off(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  enqueue(job: QueueJob<TPayload>): Promise<TResult> {
    if (this.#closed || this.#closing) {
      return Promise.reject(new QueueClosedError());
    }

    if (this.#pending.length >= this.#maxPending) {
      return Promise.reject(new QueueCapacityError(this.#maxPending));
    }

    const sequence = ++this.#sequence;
    const enqueuedAt = this.#now();
    const snapshot: QueueSnapshotInit<TPayload> = {
      id: job.id ?? `job-${sequence}`,
      payload: job.payload,
      priority: normalizePriority(job.priority),
      runAt: normalizeRunAt(job.runAt),
      enqueuedAt,
      sequence,
    };

    if (job.name !== undefined) {
      snapshot.name = job.name;
    }

    if (job.metadata !== undefined) {
      snapshot.metadata = job.metadata;
    }

    const frozenSnapshot = Object.freeze(snapshot) as QueueJobSnapshot<TPayload>;

    let resolve!: (value: TResult | PromiseLike<TResult>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<TResult>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    const entry: QueueEntry<TPayload, TResult> = {
      snapshot: frozenSnapshot,
      resolve,
      reject,
    };

    if (job.signal !== undefined) {
      entry.signal = job.signal;
    }

    if (job.signal?.aborted) {
      reject(toAbortError(job.signal.reason));
      return promise;
    }

    if (job.signal) {
      const onAbort = () => {
        if (this.#removePending(entry)) {
          reject(toAbortError(job.signal?.reason));
          this.#arm();
        }
      };

      job.signal.addEventListener("abort", onAbort, { once: true });
      entry.cleanupAbort = () => job.signal?.removeEventListener("abort", onAbort);
    }

    this.#insertPending(entry);
    this.#emit("enqueued", frozenSnapshot);
    this.#arm();
    return promise;
  }

  pause(): void {
    if (this.#paused || this.#closed) {
      return;
    }

    this.#paused = true;
    this.#clearScheduledWork();
    this.#emit("paused", this.state);
  }

  resume(): void {
    if (!this.#paused || this.#closed) {
      return;
    }

    this.#paused = false;
    this.#emit("resumed", this.state);
    this.#arm();
  }

  async drain(): Promise<void> {
    if (this.#pending.length === 0 && this.#running === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
      this.#arm();
    });
  }

  async close(options: QueueCloseOptions = {}): Promise<void> {
    if (this.#closed) {
      return;
    }

    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closing = true;

    if (options.drain === false) {
      this.#rejectPending(new QueueClosedError());
      this.#paused = false;
      this.#closed = true;
      this.#closing = false;
      this.#clearScheduledWork();
      this.#forceReleaseIdleWaiters();
      this.#emit("closed", this.state);
      return;
    }

    this.#paused = false;
    this.#arm();

    this.#closePromise = this.drain()
      .then(() => {
        this.#closed = true;
        this.#closing = false;
        this.#clearScheduledWork();
        this.#emit("closed", this.state);
      })
      .finally(() => {
        this.#closePromise = null;
      });

    return this.#closePromise;
  }

  clear(reason: unknown = new QueueClosedError()): number {
    if (this.#pending.length === 0) {
      return 0;
    }

    const pending = this.#pending.splice(0, this.#pending.length);

    for (const entry of pending) {
      entry.cleanupAbort?.();
      entry.reject(reason);
    }

    this.#arm();
    this.#emit("cleared", pending.length);
    return pending.length;
  }

  snapshot(): ReadonlyArray<QueueJobSnapshot<TPayload>> {
    return this.#pending.map((entry) => entry.snapshot);
  }

  #insertPending(entry: QueueEntry<TPayload, TResult>): void {
    this.#pending.push(entry);
    this.#pending.sort((left, right) => {
      if (left.snapshot.runAt !== right.snapshot.runAt) {
        return left.snapshot.runAt - right.snapshot.runAt;
      }

      if (left.snapshot.priority !== right.snapshot.priority) {
        return right.snapshot.priority - left.snapshot.priority;
      }

      return left.snapshot.sequence - right.snapshot.sequence;
    });
  }

  #removePending(entry: QueueEntry<TPayload, TResult>): boolean {
    const index = this.#pending.indexOf(entry);

    if (index === -1) {
      return false;
    }

    this.#pending.splice(index, 1);
    entry.cleanupAbort?.();
    return true;
  }

  #rejectPending(reason: unknown): void {
    const pending = this.#pending.splice(0, this.#pending.length);

    for (const entry of pending) {
      entry.cleanupAbort?.();
      entry.reject(reason);
    }
  }

  #clearScheduledWork(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (this.#immediate) {
      clearImmediate(this.#immediate);
      this.#immediate = null;
    }
  }

  #flushIdleWaiters(): void {
    if (this.#pending.length > 0 || this.#running > 0) {
      return;
    }

    if (this.#idleWaiters.length === 0) {
      this.#emit("drained", this.state);
      return;
    }

    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }

    this.#emit("drained", this.state);
  }

  #forceReleaseIdleWaiters(): void {
    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }

    this.#emit("drained", this.state);
  }

  #arm(): void {
    if (this.#closed || this.#paused) {
      return;
    }

    if (this.#running >= this.#concurrency) {
      return;
    }

    this.#clearScheduledWork();

    if (this.#pending.length === 0) {
      this.#flushIdleWaiters();
      return;
    }

    const next = this.#pending[0];
    if (!next) {
      this.#flushIdleWaiters();
      return;
    }

    const delay = next.snapshot.runAt - this.#now();

    if (delay > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#pump();
      }, delay);
      return;
    }

    this.#immediate = setImmediate(() => {
      this.#immediate = null;
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#closed || this.#paused) {
      return;
    }

    while (this.#running < this.#concurrency && this.#pending.length > 0) {
      const next = this.#pending[0];

      if (!next) {
        return;
      }

      if (next.snapshot.runAt > this.#now()) {
        this.#arm();
        return;
      }

      this.#pending.shift();
      next.cleanupAbort?.();
      this.#start(next);
    }

    if (this.#pending.length === 0 && this.#running === 0) {
      this.#flushIdleWaiters();
      return;
    }

    if (this.#running < this.#concurrency && this.#pending.length > 0) {
      this.#arm();
    }
  }

  #start(entry: QueueEntry<TPayload, TResult>): void {
    this.#running += 1;

    const startedAt = this.#now();
    const context: QueueContextInit<TPayload, TResult> = {
      queue: this,
      jobId: entry.snapshot.id,
      enqueuedAt: entry.snapshot.enqueuedAt,
      startedAt,
      sequence: entry.snapshot.sequence,
    };

    if (entry.signal !== undefined) {
      context.signal = entry.signal;
    }

    const frozenContext = Object.freeze(context) as QueueContext<TPayload, TResult>;

    this.#emit("started", entry.snapshot, frozenContext);

    void Promise.resolve()
      .then(() => this.#handler(entry.snapshot, frozenContext))
      .then((result) => {
        entry.resolve(result);
        this.#emit("completed", entry.snapshot, result);
      })
      .catch((error: unknown) => {
        entry.reject(error);
        this.#emit("failed", entry.snapshot, error);
      })
      .finally(() => {
        this.#running -= 1;
        if (this.#running < 0) {
          this.#running = 0;
        }

        this.#arm();
      });
  }

  #emit<TEventName extends QueueEventName<TPayload, TResult>>(
    eventName: TEventName,
    ...args: QueueEventMap<TPayload, TResult>[TEventName]
  ): void {
    this.#events.emit(eventName, ...args);
  }
}

export function createInMemoryQueue<TPayload, TResult>(
  handler: QueueTask<TPayload, TResult>,
  options: QueueOptions = {},
): InMemoryQueue<TPayload, TResult> {
  return new InMemoryQueue(handler, options);
}

export function createQueueMemoryPlugin<TPayload, TResult>(
  handler: QueueTask<TPayload, TResult>,
  options: QueueOptions = {},
): QueueMemoryPlugin<TPayload, TResult> {
  return new InMemoryQueue(handler, options) as QueueMemoryPlugin<TPayload, TResult>;
}

export function isQueueClosedError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "QueueClosedError";
}

export function isQueueAbortError(reason: unknown): boolean {
  return isAbortError(reason) || reason instanceof QueueAbortError;
}
