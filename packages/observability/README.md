# `@generic-ai/observability`

Local-first observability surface for Generic AI runs, traces, metrics, reports,
and read-only operator panels.

V1 follows ADR 0030:

- metadata-only telemetry by default;
- payload capture disabled;
- repository-owned run, event, metric, trace, pin, export-marker, and sweep
  semantics;
- read-only routes and read-only agent tools first;
- deterministic evidence reports only;
- OTEL export endpoints deferred until ownership and dedupe rules are decided.

## Entrypoints

- `@generic-ai/observability` - read-only React/client shell and shared client
  types.
- `@generic-ai/observability/server` - repositories, ingestion helpers, Hono
  routes, SSE, reports, redaction, and metric query helpers.
- `@generic-ai/observability/agent-tools` - read-only agent convenience tools.
- `@generic-ai/observability/otel` - metric descriptors only.
- `@generic-ai/observability/styles.css` - package stylesheet.

## Server Routes

`createGenericAIObservabilityRoutes()` mounts:

- `GET /health`
- `GET /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /runs/:id/trace`
- `GET /runs/:id/report`
- `GET /metrics/catalog`
- `GET /metrics/query`
- `GET /events/live`

When no `authorize` hook is supplied, routes require a local session token via
`Authorization: Bearer <token>` or `x-generic-ai-observability-token`. The route
helper returns the generated token so local launchers can surface it.

Payload, OTEL export, and mutating report/pin routes are disabled by default.
