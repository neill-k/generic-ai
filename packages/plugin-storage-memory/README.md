# @generic-ai/plugin-storage-memory

Process-local storage implementation for Generic AI. This package is intended for tests, fast local iteration, and any workflow where durability is intentionally out of scope.

## What It Provides

- `memoryStoragePlugin`: a stable package-local plugin descriptor
- `createMemoryStorage()`: a namespaced, structured-clone-backed storage instance
- `MemoryStorage` and `MemoryNamespace`: direct access to the storage view classes
- `snapshot()` / `restore()`: deterministic state capture for tests
- `transaction()`: copy-on-write commit semantics for isolated mutations

## Assumptions

- Storage lives entirely in process memory and disappears on restart.
- Stored values must be structured-cloneable.
- Reads return cloned values, so callers cannot mutate internal state by accident.
- Namespaces are isolated by string name, and record keys are isolated within each namespace.
- The implementation favors deterministic test behavior over cross-process concurrency features.

## Example

```ts
import { createMemoryStorage } from "@generic-ai/plugin-storage-memory";

const storage = createMemoryStorage();
const runs = storage.namespace("runs");

runs.set("run-1", { status: "queued" });

const snapshot = storage.snapshot();
storage.restore(snapshot);
```

## Package Boundaries

This package stays local to the in-memory storage implementation. It does not attempt to define the shared storage contract or modify shared kernel/core packages.
