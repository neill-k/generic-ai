# @generic-ai/plugin-queue-memory

In-process queue plugin for Generic AI. This package provides the first async execution path for local development and tests without requiring BullMQ, Redis, or any other external infrastructure.

## What it does

- Runs queued work in memory with a configurable concurrency limit
- Preserves stable ordering by `runAt`, then priority, then enqueue order
- Supports `pause()`, `resume()`, `drain()`, `clear()`, and `close()`
- Rejects pending jobs that are aborted before they start
- Emits lifecycle events for observability and future adapter work

## API

- `createInMemoryQueue(handler, options?)`
- `createQueueMemoryPlugin(handler, options?)`
- Typed `on(...)`, `once(...)`, and `off(...)` queue listeners
- `name` and `kind` plugin metadata
- `QueueClosedError`, `QueueCapacityError`, and `QueueAbortError`

## Example

```ts
import { createQueueMemoryPlugin } from "@generic-ai/plugin-queue-memory";

const queue = createQueueMemoryPlugin(async (job) => {
  console.log("running", job.id, job.payload);
  return { ok: true };
});

const result = await queue.enqueue({
  payload: { task: "summarize" },
  priority: 10,
});

console.log(result);
```

## Notes

- The queue stays intentionally small so it can be swapped out for an external backend later.
- Jobs can be observed through `enqueued`, `started`, `completed`, `failed`, `paused`, `resumed`, `drained`, `cleared`, and `closed` events.
- Package-local tests live in `test/index.test.ts`.
