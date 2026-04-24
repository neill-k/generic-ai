# @generic-ai/plugin-logging-otel

Structured logging plus OTEL-shaped trace capture for Generic AI. This package turns framework events into stable log records and span records without forcing the kernel to choose a logging backend or an exporter implementation up front.

## What It Provides

- `createLoggingOtelPlugin(options?)`
- `record(event)` for one-off event ingestion
- `instrument(source)` for iterable, async-iterable, or subscription-style event sources
- `done` resolves when observation stops, while `cleanup` tracks iterator shutdown for async sources
- `snapshot()` and `clear()` for tests and local inspection
- `name` and `kind` metadata

## Notes

- The package keeps a package-local representation of OTEL-style logs and spans.
- The in-memory log/span snapshot buffers are capped by default to avoid unbounded growth, and callers can tune that with `maxBufferedRecords`.
- Start/complete/fail lifecycle events with matching run, session, or delegation ids are folded into completed spans.
- The plugin can mirror log and span records to caller-provided sinks.
- This stays replaceable: future host code can map these records into a real exporter pipeline without changing kernel behavior.
- Richer metrics, dashboards, and product analytics are intentionally deferred outside this baseline package; see [`../../docs/advanced-observability.md`](../../docs/advanced-observability.md).

## Example

```ts
import { createLoggingOtelPlugin } from "@generic-ai/plugin-logging-otel";

const observability = createLoggingOtelPlugin({
  serviceName: "generic-ai.demo",
});

observability.record({
  type: "session.started",
  sessionId: "session-1",
  message: "starting session",
});

observability.record({
  type: "session.completed",
  sessionId: "session-1",
  message: "session complete",
  durationMs: 25,
});
```

## Planning Baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
