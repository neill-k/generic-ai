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
