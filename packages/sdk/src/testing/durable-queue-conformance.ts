import assert from "node:assert/strict";
import type { DurableQueueContract } from "../contracts/queue.js";
import { isDurableQueueError } from "../contracts/queue.js";
import { createManualClock, type ManualClock } from "./clock.js";

export interface DurableQueueConformanceHarness {
  readonly queue: DurableQueueContract<{ readonly n: number }, { readonly ok: boolean }>;
  /**
   * Opens a second handle on the same backing store, as a restarted process
   * would. Omit when the backend is not persistent.
   */
  reopen?(): Promise<DurableQueueContract<{ readonly n: number }, { readonly ok: boolean }>>;
  dispose(): Promise<void>;
}

/**
 * Creates a fresh, empty queue that reads time from `clock`. Backends must
 * apply these defaults so the cases can assert on them: `maxAttempts` 3,
 * `leaseMs` 30_000, backoff `{ baseMs: 1_000, maxMs: 60_000, factor: 2 }`.
 */
export type DurableQueueConformanceFactory = (
  clock: ManualClock,
) => Promise<DurableQueueConformanceHarness>;

export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

async function withQueue(
  factory: DurableQueueConformanceFactory,
  body: (harness: DurableQueueConformanceHarness, clock: ManualClock) => Promise<void>,
): Promise<void> {
  const clock = createManualClock();
  const harness = await factory(clock);
  try {
    await body(harness, clock);
  } finally {
    await harness.dispose();
  }
}

async function expectLeaseLost(operation: () => unknown): Promise<void> {
  await assert.rejects(
    async () => {
      await operation();
    },
    (error: unknown) => isDurableQueueError(error, "LEASE_LOST"),
  );
}

/**
 * Behavioural cases every `DurableQueueContract` backend must pass. Register
 * them with any test runner, for example
 * `for (const c of durableQueueConformanceCases(factory)) it(c.name, c.run)`.
 */
export function durableQueueConformanceCases(
  factory: DurableQueueConformanceFactory,
): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [
    {
      name: "enqueue applies defaults and get returns the job",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          const job = await queue.enqueue({ name: "task", payload: { n: 1 } });
          assert.equal(job.state, "queued");
          assert.equal(job.attempts, 0);
          assert.equal(job.priority, 0);
          assert.equal(job.maxAttempts, 3);
          assert.equal(job.name, "task");
          assert.deepEqual(job.payload, { n: 1 });
          assert.equal(job.enqueuedAt, new Date(clock.now()).toISOString());
          assert.equal(job.availableAt, new Date(clock.now()).toISOString());
          assert.ok(job.id.length > 0);

          const fetched = await queue.get(job.id);
          assert.equal(fetched?.id, job.id);
          assert.deepEqual(fetched?.payload, { n: 1 });
          assert.equal(await queue.get("missing-job"), undefined);
        }),
    },
    {
      name: "leases by priority, then availability, then enqueue order",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "low", name: "task", payload: { n: 1 } });
          clock.advance(1);
          await queue.enqueue({ id: "high", name: "task", payload: { n: 2 }, priority: 10 });
          clock.advance(1);
          await queue.enqueue({ id: "low-2", name: "task", payload: { n: 3 } });

          const order: string[] = [];
          for (;;) {
            const lease = await queue.lease();
            if (!lease) {
              break;
            }
            order.push(lease.id);
          }
          assert.deepEqual(order, ["high", "low", "low-2"]);
        }),
    },
    {
      name: "lease filters by job name",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({ id: "a", name: "alpha", payload: { n: 1 } });
          await queue.enqueue({ id: "b", name: "beta", payload: { n: 2 } });
          const lease = await queue.lease({ names: ["beta"] });
          assert.equal(lease?.id, "b");
          assert.equal(await queue.lease({ names: ["beta"] }), undefined);
          assert.equal((await queue.lease({ names: ["alpha", "gamma"] }))?.id, "a");
        }),
    },
    {
      name: "delayed jobs are not leased before availableAt",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({
            id: "later",
            name: "task",
            payload: { n: 1 },
            availableAt: clock.now() + 5_000,
          });
          assert.equal(await queue.lease(), undefined);
          clock.advance(5_000);
          assert.equal((await queue.lease())?.id, "later");
        }),
    },
    {
      name: "lease records attempt, worker and expiry",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 } });
          const lease = await queue.lease({ workerId: "w1", leaseMs: 10_000 });
          assert.ok(lease);
          assert.equal(lease.state, "leased");
          assert.equal(lease.attempts, 1);
          assert.equal(lease.leasedBy, "w1");
          assert.equal(lease.leaseExpiresAt, new Date(clock.now() + 10_000).toISOString());
          const stored = await queue.get("j");
          assert.equal(stored?.state, "leased");
          assert.equal(stored?.leaseId, lease.leaseId);
        }),
    },
    {
      name: "ack completes the job and stores the result",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 } });
          const lease = await queue.lease();
          assert.ok(lease);
          clock.advance(250);
          const done = await queue.ack(lease.leaseId, { ok: true });
          assert.equal(done.state, "succeeded");
          assert.deepEqual(done.result, { ok: true });
          assert.equal(done.completedAt, new Date(clock.now()).toISOString());
          assert.equal(done.leaseId, undefined);
          await expectLeaseLost(() => queue.ack(lease.leaseId, { ok: true }));
          await expectLeaseLost(() => queue.nack(lease.leaseId));
          assert.equal(await queue.lease(), undefined);
        }),
    },
    {
      name: "nack retries with exponential backoff, then dead-letters",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 } });

          const first = await queue.lease();
          assert.ok(first);
          const retried = await queue.nack(first.leaseId, { reason: "boom-1" });
          assert.equal(retried.state, "queued");
          assert.equal(retried.lastError, "boom-1");
          assert.equal(retried.availableAt, new Date(clock.now() + 1_000).toISOString());
          assert.equal(await queue.lease(), undefined);

          clock.advance(1_000);
          const second = await queue.lease();
          assert.equal(second?.attempts, 2);
          assert.ok(second);
          const retriedAgain = await queue.nack(second.leaseId, { reason: "boom-2" });
          assert.equal(retriedAgain.availableAt, new Date(clock.now() + 2_000).toISOString());

          clock.advance(2_000);
          const third = await queue.lease();
          assert.equal(third?.attempts, 3);
          assert.ok(third);
          const dead = await queue.nack(third.leaseId, { reason: "boom-3" });
          assert.equal(dead.state, "failed");
          assert.equal(dead.lastError, "boom-3");
          assert.equal(dead.completedAt, new Date(clock.now()).toISOString());

          const deadLetters = await queue.list({ state: "failed" });
          assert.deepEqual(
            deadLetters.map((job) => job.id),
            ["j"],
          );
        }),
    },
    {
      name: "nack honours retryable false and explicit delay",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "a", name: "task", payload: { n: 1 } });
          await queue.enqueue({ id: "b", name: "task", payload: { n: 2 } });
          const a = await queue.lease();
          const b = await queue.lease();
          assert.ok(a && b);
          const dead = await queue.nack(a.leaseId, { reason: "bad input", retryable: false });
          assert.equal(dead.state, "failed");
          const delayed = await queue.nack(b.leaseId, { delayMs: 0 });
          assert.equal(delayed.state, "queued");
          assert.equal(delayed.availableAt, new Date(clock.now()).toISOString());
          assert.equal((await queue.lease())?.id, "b");
        }),
    },
    {
      name: "retry revives a dead-lettered job with fresh attempts",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 }, maxAttempts: 1 });
          const lease = await queue.lease();
          assert.ok(lease);
          assert.equal((await queue.nack(lease.leaseId, { reason: "x" })).state, "failed");
          assert.equal(await queue.retry("j"), true);
          const revived = await queue.get("j");
          assert.equal(revived?.state, "queued");
          assert.equal(revived?.attempts, 0);
          assert.equal((await queue.lease())?.id, "j");
          assert.equal(await queue.retry("j"), false);
          assert.equal(await queue.retry("missing"), false);
        }),
    },
    {
      name: "expired leases are reclaimed and the old lease is lost",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 } });
          const crashed = await queue.lease({ workerId: "w1", leaseMs: 1_000 });
          assert.ok(crashed);
          assert.equal(await queue.lease(), undefined);

          clock.advance(1_001);
          const recovered = await queue.lease({ workerId: "w2" });
          assert.equal(recovered?.id, "j");
          assert.equal(recovered?.attempts, 2);
          assert.notEqual(recovered?.leaseId, crashed.leaseId);

          await expectLeaseLost(() => queue.ack(crashed.leaseId, { ok: true }));
          assert.equal(await queue.heartbeat(crashed.leaseId), false);
          assert.ok(recovered);
          assert.equal((await queue.ack(recovered.leaseId, { ok: true })).state, "succeeded");
        }),
    },
    {
      name: "reclaimExpired requeues, and dead-letters when attempts run out",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "retry", name: "task", payload: { n: 1 } });
          await queue.enqueue({ id: "last", name: "task", payload: { n: 2 }, maxAttempts: 1 });
          assert.ok(await queue.lease({ leaseMs: 1_000 }));
          assert.ok(await queue.lease({ leaseMs: 1_000 }));
          assert.equal(await queue.reclaimExpired(), 0);
          clock.advance(1_001);
          assert.equal(await queue.reclaimExpired(), 2);
          assert.equal((await queue.get("retry"))?.state, "queued");
          const last = await queue.get("last");
          assert.equal(last?.state, "failed");
          assert.match(last?.lastError ?? "", /lease expired/i);
        }),
    },
    {
      name: "heartbeat extends a lease so it is not reclaimed",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "j", name: "task", payload: { n: 1 } });
          const lease = await queue.lease({ leaseMs: 1_000 });
          assert.ok(lease);
          clock.advance(900);
          assert.equal(await queue.heartbeat(lease.leaseId, 1_000), true);
          clock.advance(900);
          assert.equal(await queue.reclaimExpired(), 0);
          assert.equal(await queue.lease(), undefined);
          assert.equal(
            (await queue.get("j"))?.leaseExpiresAt,
            new Date(clock.now() + 100).toISOString(),
          );
          assert.equal(await queue.heartbeat("not-a-lease"), false);
        }),
    },
    {
      name: "concurrencyKey allows one leased job per key",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({
            id: "ceo-1",
            name: "task",
            payload: { n: 1 },
            concurrencyKey: "ceo",
          });
          await queue.enqueue({
            id: "ceo-2",
            name: "task",
            payload: { n: 2 },
            concurrencyKey: "ceo",
          });
          await queue.enqueue({
            id: "vp-1",
            name: "task",
            payload: { n: 3 },
            concurrencyKey: "vp",
          });

          const first = await queue.lease();
          assert.equal(first?.id, "ceo-1");
          assert.equal(first?.concurrencyKey, "ceo");
          const second = await queue.lease();
          assert.equal(second?.id, "vp-1");
          assert.equal(await queue.lease(), undefined);

          assert.ok(first);
          await queue.ack(first.leaseId, { ok: true });
          assert.equal((await queue.lease())?.id, "ceo-2");
        }),
    },
    {
      name: "concurrent leases never hand out the same job twice",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          for (let n = 0; n < 8; n += 1) {
            await queue.enqueue({ id: `j${n}`, name: "task", payload: { n } });
          }
          await queue.enqueue({ id: "k1", name: "task", payload: { n: 100 }, concurrencyKey: "k" });
          await queue.enqueue({ id: "k2", name: "task", payload: { n: 101 }, concurrencyKey: "k" });

          const leases = await Promise.all(Array.from({ length: 16 }, () => queue.lease()));
          const ids = leases.flatMap((lease) => (lease ? [lease.id] : []));
          assert.equal(new Set(ids).size, ids.length, "a job was leased twice");
          assert.equal(ids.length, 9);
          assert.equal(ids.filter((id) => id.startsWith("k")).length, 1);
        }),
    },
    {
      name: "idempotencyKey returns the existing job",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          const first = await queue.enqueue({
            name: "task",
            payload: { n: 1 },
            idempotencyKey: "delegate:abc",
          });
          const second = await queue.enqueue({
            name: "task",
            payload: { n: 2 },
            idempotencyKey: "delegate:abc",
          });
          assert.equal(second.id, first.id);
          assert.deepEqual(second.payload, { n: 1 });
          assert.equal(await queue.size(), 1);
        }),
    },
    {
      name: "enqueue rejects a duplicate id",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({ id: "dup", name: "task", payload: { n: 1 } });
          await assert.rejects(
            async () => {
              await queue.enqueue({ id: "dup", name: "task", payload: { n: 2 } });
            },
            (error: unknown) => isDurableQueueError(error, "INVALID_INPUT"),
          );
        }),
    },
    {
      name: "cancel stops queued jobs and flags leased ones",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({ id: "queued", name: "task", payload: { n: 1 } });
          await queue.enqueue({ id: "running", name: "task", payload: { n: 2 }, priority: 5 });
          await queue.enqueue({ id: "finishes", name: "task", payload: { n: 3 }, priority: 4 });
          const running = await queue.lease();
          const finishes = await queue.lease();
          assert.equal(running?.id, "running");
          assert.equal(finishes?.id, "finishes");
          assert.ok(running && finishes);

          assert.equal(await queue.cancel("queued"), true);
          assert.equal((await queue.get("queued"))?.state, "cancelled");
          assert.equal(await queue.lease(), undefined);

          assert.equal(await queue.cancel("running"), true);
          assert.equal((await queue.get("running"))?.cancelRequested, true);
          assert.equal(await queue.heartbeat(running.leaseId), false);
          const cancelled = await queue.nack(running.leaseId, { reason: "aborted" });
          assert.equal(cancelled.state, "cancelled");

          assert.equal(await queue.cancel("finishes"), true);
          const finished = await queue.ack(finishes.leaseId, { ok: true });
          assert.equal(finished.state, "succeeded");

          assert.equal(await queue.cancel("finishes"), false);
          assert.equal(await queue.cancel("missing"), false);
        }),
    },
    {
      name: "size, stats and list reflect job states",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({ id: "a", name: "alpha", payload: { n: 1 }, scopeId: "s1" });
          await queue.enqueue({ id: "b", name: "alpha", payload: { n: 2 }, concurrencyKey: "k" });
          await queue.enqueue({ id: "c", name: "beta", payload: { n: 3 } });
          await queue.enqueue({ id: "d", name: "beta", payload: { n: 4 } });
          const leased = await queue.lease({ names: ["alpha"] });
          assert.equal(leased?.id, "a");
          await queue.cancel("d");

          assert.equal(await queue.size(), 3);
          assert.equal(await queue.size("alpha"), 2);
          assert.equal(await queue.size("beta"), 1);
          assert.deepEqual(await queue.stats(), {
            queued: 2,
            leased: 1,
            succeeded: 0,
            failed: 0,
            cancelled: 1,
          });
          assert.deepEqual(
            (await queue.list({ name: "beta" })).map((job) => job.id),
            ["c", "d"],
          );
          assert.deepEqual(
            (await queue.list({ state: ["leased", "cancelled"] })).map((job) => job.id).sort(),
            ["a", "d"],
          );
          assert.deepEqual(
            (await queue.list({ concurrencyKey: "k" })).map((job) => job.id),
            ["b"],
          );
          assert.deepEqual(
            (await queue.list({ scopeId: "s1" })).map((job) => job.id),
            ["a"],
          );
          assert.equal((await queue.list({ limit: 2 })).length, 2);
        }),
    },
    {
      name: "purge deletes old terminal jobs only",
      run: () =>
        withQueue(factory, async ({ queue }, clock) => {
          await queue.enqueue({ id: "old", name: "task", payload: { n: 1 } });
          await queue.enqueue({ id: "open", name: "task", payload: { n: 2 } });
          const lease = await queue.lease();
          assert.equal(lease?.id, "old");
          assert.ok(lease);
          await queue.ack(lease.leaseId, { ok: true });
          clock.advance(10_000);
          assert.equal(await queue.purge({ completedBefore: clock.now() }), 1);
          assert.equal(await queue.get("old"), undefined);
          assert.equal((await queue.get("open"))?.state, "queued");
        }),
    },
    {
      name: "metadata and scope survive the round trip",
      run: () =>
        withQueue(factory, async ({ queue }) => {
          await queue.enqueue({
            id: "j",
            name: "task",
            payload: { n: 7 },
            scopeId: "scope-1",
            metadata: { agentId: "ceo", tags: ["a", "b"], nested: { x: 1 } },
          });
          const lease = await queue.lease();
          assert.equal(lease?.scopeId, "scope-1");
          assert.deepEqual(lease?.metadata, { agentId: "ceo", tags: ["a", "b"], nested: { x: 1 } });
          assert.deepEqual(lease?.payload, { n: 7 });
        }),
    },
    {
      name: "jobs survive reopening the store",
      run: () =>
        withQueue(factory, async (harness, clock) => {
          if (!harness.reopen) {
            return;
          }
          await harness.queue.enqueue({ id: "persisted", name: "task", payload: { n: 1 } });
          const crashed = await harness.queue.lease({ leaseMs: 1_000 });
          assert.ok(crashed);
          await harness.queue.enqueue({ id: "waiting", name: "task", payload: { n: 2 } });

          const restarted = await harness.reopen();
          try {
            assert.equal((await restarted.lease())?.id, "waiting");
            clock.advance(1_001);
            const recovered = await restarted.lease();
            assert.equal(recovered?.id, "persisted");
            assert.equal(recovered?.attempts, 2);
          } finally {
            await restarted.close?.();
          }
        }),
    },
  ];
  return cases;
}
