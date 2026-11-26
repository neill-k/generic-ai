import {
  createCanonicalEventStream,
  createQueueWorker,
  attachRunEventLog,
  replayRunEvents,
  NonRetryableJobError,
} from "@generic-ai/sdk";
import type { CanonicalEvent } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPostgresSchemaVersion,
  LATEST_POSTGRES_SCHEMA_VERSION,
  migratePostgres,
  openPostgresStorage,
  type PostgresPool,
  resolvePostgresConnection,
  type PostgresStorage,
} from "../src/index.js";
import { createTestPool, dropSchema, postgresUrl, uniqueSchema } from "./helpers.js";

describe("openPostgresStorage configuration", () => {
  it("requires a pool, connection string or DATABASE_URL", async () => {
    const previous = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      await expect(openPostgresStorage({ migrate: false })).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (previous !== undefined) {
        process.env["DATABASE_URL"] = previous;
      }
    }
  });

  it("rejects unsafe schema names", async () => {
    await expect(
      openPostgresStorage({
        connectionString: "postgres://x",
        schema: 'bad"; DROP',
        migrate: false,
      }),
    ).rejects.toThrow(/Invalid Postgres schema name/);
  });

  it("survives an idle connection error on a pool it creates", async () => {
    const errors: Error[] = [];
    const { pool, ownsPool } = resolvePostgresConnection({
      connectionString: "postgres://user:pass@127.0.0.1:1/db",
      onPoolError: (error) => errors.push(error),
    });
    expect(ownsPool).toBe(true);
    // pg emits "error" on the pool when an idle client's connection drops,
    // for example when Postgres restarts. Without a listener that throws.
    const emitter = pool as unknown as { emit(event: string, error: Error): boolean };
    expect(() =>
      emitter.emit("error", new Error("terminating connection due to administrator command")),
    ).not.toThrow();
    expect(errors.map((error) => error.message)).toEqual([
      "terminating connection due to administrator command",
    ]);
    await pool.end();
  });
});

describe.skipIf(!postgresUrl)("postgres storage", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function open(): Promise<{ storage: PostgresStorage; pool: PostgresPool; schema: string }> {
    const pool = createTestPool();
    const schema = uniqueSchema();
    const storage = await openPostgresStorage({ pool, schema });
    cleanups.push(async () => {
      await dropSchema(pool, schema);
      await storage.close();
      await pool.end();
    });
    return { storage, pool, schema };
  }

  it("migrates once, is idempotent, and is safe to run concurrently", async () => {
    const pool = createTestPool();
    const schema = uniqueSchema();
    cleanups.push(async () => {
      await dropSchema(pool, schema);
      await pool.end();
    });
    expect(await getPostgresSchemaVersion(pool, schema)).toBe(0);
    const results = await Promise.all([1, 2, 3, 4].map(() => migratePostgres(pool, schema)));
    const applied = results.flatMap((result) => result.applied);
    expect(applied).toEqual([1, 2, 3]);
    expect(await getPostgresSchemaVersion(pool, schema)).toBe(LATEST_POSTGRES_SCHEMA_VERSION);
    expect((await migratePostgres(pool, schema)).applied).toEqual([]);
  });

  it("reports health and does not end a pool it does not own", async () => {
    const { storage, pool } = await open();
    expect(await storage.healthCheck()).toEqual({
      ok: true,
      schemaVersion: LATEST_POSTGRES_SCHEMA_VERSION,
      expectedSchemaVersion: LATEST_POSTGRES_SCHEMA_VERSION,
    });
    await storage.close();
    const result = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(result.rows[0]?.one).toBe(1);
  });

  it("reports an unmigrated schema as unhealthy", async () => {
    const pool = createTestPool();
    const schema = uniqueSchema();
    const storage = await openPostgresStorage({ pool, schema, migrate: false });
    cleanups.push(async () => {
      await pool.end();
    });
    const health = await storage.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.schemaVersion).toBe(0);
  });

  it("implements the key-value StorageContract", async () => {
    const { storage } = await open();
    const kv = storage.storage;
    await kv.set({
      key: { namespace: "ns", collection: "agents", id: "ceo" },
      value: { role: "CEO", reports: ["vp"] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: { source: "yaml" },
    });
    await kv.set({
      key: { namespace: "ns", collection: "agents", id: "cto" },
      value: { role: "CTO" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await kv.set({
      key: { namespace: "ns", collection: "board", id: "item-1" },
      value: "ship it",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await kv.get({ namespace: "ns", collection: "agents", id: "ceo" })).toEqual({
      key: { namespace: "ns", collection: "agents", id: "ceo" },
      value: { role: "CEO", reports: ["vp"] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      metadata: { source: "yaml" },
    });
    expect((await kv.list({ collection: "agents", prefix: "c" })).map((r) => r.key.id)).toEqual([
      "ceo",
      "cto",
    ]);
    await kv.set({
      key: { namespace: "ns", collection: "agents", id: "ceo" },
      value: { role: "Chief" },
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const updated = await kv.get<{ role: string }>({
      namespace: "ns",
      collection: "agents",
      id: "ceo",
    });
    expect(updated?.value.role).toBe("Chief");
    expect(updated?.metadata).toBeUndefined();
    expect(await kv.delete({ namespace: "ns", collection: "agents", id: "ceo" })).toBe(true);
    expect(await kv.delete({ namespace: "ns", collection: "agents", id: "ceo" })).toBe(false);
    await kv.clear({ collection: "agents" });
    expect((await kv.list()).map((r) => r.key.id)).toEqual(["item-1"]);
    await kv.clear();
    expect(await kv.list()).toEqual([]);
  });

  it("persists a live event stream and replays it after a restart", async () => {
    const { storage, pool, schema } = await open();
    const stream = createCanonicalEventStream();
    await attachRunEventLog(stream, storage.runs);
    const context = {
      scopeId: "scope",
      runId: "run-1",
      rootSessionId: "root",
      sessionId: "root",
    };
    await stream.emit({ ...context, name: "run.created" });
    await stream.emit({ ...context, name: "run.started" });
    await stream.emit({ ...context, name: "session.started", data: { agent: "ceo" } });
    stream.close();

    const restarted = await openPostgresStorage({ pool, schema, migrate: false });
    const replayed: CanonicalEvent[] = [];
    const count = await replayRunEvents(
      restarted.runs,
      "run-1",
      (event) => {
        replayed.push(event);
      },
      { batchSize: 2 },
    );
    expect(count).toBe(3);
    expect(replayed.map((event) => event.name)).toEqual([
      "run.created",
      "run.started",
      "session.started",
    ]);
    expect(replayed[2]?.data).toEqual({ agent: "ceo" });
    expect(stream.snapshot()).toEqual(replayed);
  });

  it("processes every job exactly once across several workers", async () => {
    const { storage } = await open();
    const queue = storage.queue<{ n: number }, { doubled: number }>({ leaseMs: 5_000 });
    const total = 60;
    for (let n = 0; n < total; n += 1) {
      await queue.enqueue({
        name: "double",
        payload: { n },
        ...(n % 3 === 0 ? { concurrencyKey: `agent-${n % 2}` } : {}),
      });
    }
    const seen = new Map<number, number>();
    const runningPerKey = new Map<string, number>();
    let keyViolations = 0;
    const workers = [1, 2, 3, 4].map((index) =>
      createQueueWorker(
        queue,
        async (job) => {
          const key = job.concurrencyKey;
          if (key) {
            const running = (runningPerKey.get(key) ?? 0) + 1;
            runningPerKey.set(key, running);
            if (running > 1) {
              keyViolations += 1;
            }
          }
          seen.set(job.payload.n, (seen.get(job.payload.n) ?? 0) + 1);
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (key) {
            runningPerKey.set(key, (runningPerKey.get(key) ?? 1) - 1);
          }
          return { doubled: job.payload.n * 2 };
        },
        { workerId: `w${index}`, concurrency: 3, pollIntervalMs: 10 },
      ),
    );
    for (const worker of workers) {
      worker.start();
    }
    await waitFor(async () => (await queue.stats()).succeeded === total, 15_000);
    await Promise.all(workers.map((worker) => worker.stop()));
    expect(seen.size).toBe(total);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    expect(keyViolations).toBe(0);
    const done = await queue.list({ state: "succeeded", limit: 1 });
    expect(done[0]?.result).toEqual({ doubled: (done[0]?.payload.n ?? 0) * 2 });
  });

  it("resumes a job abandoned by a crashed worker", async () => {
    const { storage } = await open();
    const queue = storage.queue<{ step: string }, string>();
    await queue.enqueue({ id: "task", name: "work", payload: { step: "build" } });
    // A worker leases the job and then dies without settling it.
    const crashed = await queue.lease({ workerId: "crashed", leaseMs: 200 });
    expect(crashed?.id).toBe("task");

    const events: string[] = [];
    const worker = createQueueWorker(queue, async (job) => `done:${job.payload.step}`, {
      workerId: "survivor",
      pollIntervalMs: 25,
      leaseMs: 1_000,
      onEvent: (event) => events.push(event.type),
    });
    worker.start();
    await waitFor(async () => (await queue.get("task"))?.state === "succeeded", 5_000);
    await worker.stop();
    const job = await queue.get("task");
    expect(job?.attempts).toBe(2);
    expect(job?.leasedBy).toBe("survivor");
    expect(job?.result).toBe("done:build");
    expect(events).toContain("succeeded");
  });

  it("retries failing jobs with backoff and dead-letters non-retryable ones", async () => {
    const { storage } = await open();
    const queue = storage.queue<{ fail: "transient" | "fatal" }, string>({
      backoff: { baseMs: 10, maxMs: 50 },
      maxAttempts: 3,
    });
    await queue.enqueue({ id: "flaky", name: "work", payload: { fail: "transient" } });
    await queue.enqueue({ id: "fatal", name: "work", payload: { fail: "fatal" } });
    let flakyCalls = 0;
    const events: string[] = [];
    const worker = createQueueWorker(
      queue,
      async (job) => {
        if (job.payload.fail === "fatal") {
          throw new NonRetryableJobError("bad input");
        }
        flakyCalls += 1;
        if (flakyCalls < 3) {
          throw new Error(`transient ${flakyCalls}`);
        }
        return "ok";
      },
      { pollIntervalMs: 5, onEvent: (event) => events.push(`${event.type}`) },
    );
    worker.start();
    await waitFor(async () => {
      const stats = await queue.stats();
      return stats.succeeded === 1 && stats.failed === 1;
    }, 5_000);
    await worker.stop();
    expect((await queue.get("flaky"))?.attempts).toBe(3);
    const fatal = await queue.get("fatal");
    expect(fatal?.attempts).toBe(1);
    expect(fatal?.lastError).toBe("bad input");
    expect(events.filter((type) => type === "retrying")).toHaveLength(2);
    expect(events).toContain("dead-lettered");
  });

  it("aborts a running handler when its job is cancelled", async () => {
    const { storage } = await open();
    const queue = storage.queue<{ n: number }, string>();
    await queue.enqueue({ id: "long", name: "work", payload: { n: 1 } });
    let sawAbort = false;
    const worker = createQueueWorker(
      queue,
      (_job, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("cancelled by owner"));
          });
        }),
      { pollIntervalMs: 10, leaseMs: 300, heartbeatMs: 20 },
    );
    worker.start();
    await waitFor(async () => (await queue.get("long"))?.state === "leased", 2_000);
    expect(await queue.cancel("long")).toBe(true);
    await waitFor(async () => (await queue.get("long"))?.state === "cancelled", 2_000);
    await worker.stop();
    expect(sawAbort).toBe(true);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
