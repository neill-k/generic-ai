---
"@generic-ai/sdk": minor
"@generic-ai/plugin-storage-postgres": minor
"@generic-ai/plugin-storage-sqlite": minor
---

Add durable run storage and a durable job queue. The SDK gains `RunStoreContract`, `DurableQueueContract`, `createQueueWorker`, `attachRunEventLog`, `replayRunEvents`, and shared conformance suites under `@generic-ai/sdk/testing`. The new `@generic-ai/plugin-storage-postgres` package provides key-value storage, a run store and a durable queue on Postgres with versioned migrations; `@generic-ai/plugin-storage-sqlite` adds `SqliteRunStore` and `SqliteQueue` for local and single-node use.
