# @generic-ai/plugin-storage-sqlite

Durable local storage for Generic AI backed by Node 24's built-in `node:sqlite` module. This package mirrors the namespaced storage shape used by the in-memory adapter, but persists values on disk so local runs survive process restarts.

## What It Provides

- `createSqliteStorage(options)`
- `sqliteStoragePlugin`
- `SqliteStorage` and `SqliteNamespace`
- `snapshot()` / `restore()`
- `transaction()` and `migrate()`

## Storage Model

- Records are keyed by `namespace` + `key`.
- Values are stored as `node:v8` serialized blobs.
- Schema initialization uses `PRAGMA user_version`.
- File-backed databases enable `WAL`, `foreign_keys`, and `trusted_schema = OFF`.

## Example

```ts
import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";

const storage = createSqliteStorage({
  path: ".generic-ai/storage.sqlite",
});

storage.namespace("runs").set("run-1", {
  status: "queued",
});
```

## Planning Baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
