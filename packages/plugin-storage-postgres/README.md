# @generic-ai/plugin-storage-postgres

Production storage for Generic AI on Postgres. One package gives a deployment
everything it needs to survive restarts and run more than one worker:

- **Key-value storage** implementing the SDK `StorageContract`.
- **Run store** implementing `RunStoreContract`: run envelopes with optimistic
  versioning, sessions with opaque runtime state, and the append-only canonical
  event log of every run, with replay.
- **Durable queue** implementing `DurableQueueContract`: time-bounded leases
  that expire when a worker dies, heartbeats, retries with exponential backoff,
  a dead-letter state, at most one leased job per `concurrencyKey` (for example
  one task per agent), idempotent enqueue, and cancellation a running worker
  can see.
- **Versioned migrations** applied in one transaction under an advisory lock,
  so several processes starting together do not race.

## Quick start

```ts
import { attachRunEventLog, createQueueWorker } from "@generic-ai/sdk";
import { openPostgresStorage } from "@generic-ai/plugin-storage-postgres";

// Reads DATABASE_URL (as Railway sets it) when no pool or connectionString is given.
const db = await openPostgresStorage();

// Persist a run's canonical event stream as it happens.
await attachRunEventLog(eventStream, db.runs);

// Queue work and process it with any number of workers, in any number of processes.
const queue = db.queue<{ agentId: string; task: string }, { summary: string }>();
await queue.enqueue({
  name: "agent-task",
  payload: { agentId: "ceo", task: "Plan the launch" },
  concurrencyKey: "agent:ceo",
  idempotencyKey: "delegation:abc123",
});

const worker = createQueueWorker(queue, async (job, { signal }) => {
  return { summary: await runAgent(job.payload, signal) };
}, { concurrency: 4 });
worker.start();

process.on("SIGTERM", async () => {
  await worker.stop();
  await db.close();
});
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `pool` | none | Share an existing `pg.Pool`. The storage never ends a pool it did not create. |
| `connectionString` | `DATABASE_URL` | Used to create a pool when `pool` is not given. |
| `maxConnections` | `10` | Size of the pool the storage creates. |
| `schema` | `generic_ai` | All tables live in this schema. |
| `migrate` | `true` | Set to `false` to run `db.migrate()` as a separate deploy step. |
| `queue` | 3 attempts, 30 s lease, 1 s to 60 s backoff | Defaults for `db.queue()`. |

## Operations

- `db.healthCheck()` returns `{ ok, schemaVersion, expectedSchemaVersion }` for
  readiness probes. It is `ok: false` until migrations have run.
- Dead letters are jobs in the `failed` state: `queue.list({ state: "failed" })`,
  and `queue.retry(id)` puts one back with fresh attempts.
- `queue.purge({ completedBefore })` deletes old finished jobs.
- Timestamps come from the application clock. Keep hosts NTP-synced when
  workers run on more than one machine.

## Tests

The Postgres tests run when `GENERIC_AI_TEST_POSTGRES_URL` points at a database
where they may create and drop schemas, and are skipped otherwise:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
GENERIC_AI_TEST_POSTGRES_URL=postgres://postgres@localhost:5432/postgres \
  npm test -- packages/plugin-storage-postgres
```

The run store and queue pass the shared conformance suites in
`@generic-ai/sdk/testing`, the same suites the SQLite backends run.
