# 0043 — Durable run store and queue

- Status: accepted
- Date: 2026-11-26
- Roadmap items: R6 (durable run store) and R7 (durable queue and workers) of the
  Generic Corp production roadmap.
- Related: `0010-run-envelope.md`, `0025-canonical-harness-event-schema-v0-1.md`,
  `0035-sdk-contracts.md`

## Context

Generic Corp runs persistent agents whose work outlives any single process: a
CEO delegates to VPs, VPs to ICs, and results cascade back up over minutes or
hours. Before this change the only queue was in-process
(`plugin-queue-memory`) and the only durable storage was a single-file SQLite
key-value store. A restart lost all queued and running work, runs and their
event streams existed only in memory, and nothing could be shared between
processes. Production runs on Railway with Postgres, with Docker for local
testing.

## Decision

1. **Two new SDK contracts.**
   - `RunStoreContract` persists run envelopes (with optimistic versioning),
     sessions (with opaque runtime state), and each run's append-only canonical
     event log. Appends are idempotent per `(runId, sequence)` when the
     `eventId` matches, so at-least-once delivery from an event stream is safe.
   - `DurableQueueContract` extends the queue vocabulary with expiring leases,
     heartbeats, retries with exponential backoff, a dead-letter state (the
     existing `failed` job state), per-key concurrency, idempotent enqueue,
     cancellation visible to running workers, and purge. The original
     `QueueContract` is unchanged.
2. **Backend-agnostic runtime helpers in the SDK.** `createQueueWorker` leases,
   heartbeats, acks and nacks against any `DurableQueueContract`, and drains
   gracefully on stop. `attachRunEventLog` persists a canonical event stream;
   `replayRunEvents` reads it back in order.
3. **Shared conformance suites.** `@generic-ai/sdk/testing` exports
   `runStoreConformanceCases` and `durableQueueConformanceCases`, written with
   `node:assert` so any test runner can use them. Every backend must pass them.
4. **Postgres is the production backend** (`@generic-ai/plugin-storage-postgres`).
   Leasing uses `FOR UPDATE SKIP LOCKED`; a partial unique index enforces one
   leased job per concurrency key. Migrations are versioned, append-only, and
   applied under an advisory lock. Connection defaults to `DATABASE_URL`.
5. **SQLite stays the local and single-node backend.**
   `plugin-storage-sqlite` gains `SqliteRunStore` and `SqliteQueue` that share
   the database file with the existing key-value store.
6. **We do not adopt pg-boss.** Its lease, retry and concurrency semantics do
   not map cleanly onto per-agent concurrency keys and idempotent delegation,
   and owning the SQL lets SQLite and Postgres share one contract and one test
   suite.

## Consequences

- Core and the topology scheduler are untouched; wiring the agent harness to
  persist runs and to dispatch delegated work through the queue is follow-up
  work (roadmap R8 and R9).
- `plugin-queue-memory` remains for tests and single-process demos.
- Queue timestamps use the application clock. Hosts running workers must be
  NTP-synced; a later change can move lease comparisons to database time if
  multi-host clock skew becomes a problem.
- Postgres tests need `GENERIC_AI_TEST_POSTGRES_URL`; CI provides a Postgres
  service for the test job.
