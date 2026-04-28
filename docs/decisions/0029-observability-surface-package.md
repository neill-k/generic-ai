# 0029. Observability Surface Package

## Status

Accepted.

## Context

ADR 0020 (`docs/decisions/0020-advanced-observability.md`) deferred advanced
observability beyond the OTEL logs/traces baseline and prescribed the resumption
order: metric vocabulary and contracts first, then an OTEL metrics adapter, then
a reference operator view, then product analytics. The next package plan needs a
public observability surface without reversing that order or making sensitive
payload capture the default.

ADR 0028 is reserved for the parallel `@generic-ai/web-ui` surface package if
that package plan lands first. This record intentionally uses 0029 so the two
surface-package decisions do not collide.

## Decision

Generic AI will add `@generic-ai/observability` as a public **surface package**.
Surface packages are public packages that expose user-facing routes, clients, UI
shells, or agent-facing convenience tools without becoming kernel, SDK, plugin,
or preset layers. Surface packages may depend on `@generic-ai/sdk` and on
documented plugin packages when they consume public plugin contracts. They must
not import `@generic-ai/core` or `@generic-ai/preset-*`.

`@generic-ai/observability` extends ADR 0020 with this V1 scope:

- metadata-only telemetry by default;
- payload capture disabled unless a later ADR and implementation add explicit
  opt-in, allowlists, size caps, secret detection, fail-closed redaction, a clear
  storage location, and a purge command;
- package-owned `ObservabilityRepository` contracts instead of stretching the
  generic storage contract beyond `get`/`set`/`delete`/`list`;
- memory and SQLite repository implementations with append, ingest-run-result,
  list-by-workspace/time/status, trace fetch, pinning, size accounting, export
  markers, duplicate handling, active-run protection, and transactional sweep
  semantics;
- metric catalog and bounded attribute vocabulary before dashboard work;
- read-only Hono routes before mutating routes;
- strict local posture: loopback host checks by default, local session token when
  no `authorize` hook is supplied, strict Host/Origin checks for non-GET
  requests, and disabled payload/export/report mutation routes unless explicitly
  enabled by package options;
- deterministic evidence-derived reports only; LLM-authored reports remain
  deferred.

Entrypoints are explicitly isolated:

- `@generic-ai/observability` exports the React/read-only client shell and shared
  client types.
- `@generic-ai/observability/server` exports Hono route helpers, repository
  implementations, ingestion helpers, security helpers, SSE helpers, reports,
  and server-side types.
- `@generic-ai/observability/agent-tools` exports read-only agent convenience
  tools that call the same repository/query services.
- `@generic-ai/observability/otel` exports metric descriptors only. It must not
  independently emit duplicate spans or logs.
- `@generic-ai/observability/styles.css` exports the package stylesheet.

OTEL ownership for V1 is deliberately narrow: `@generic-ai/plugin-logging-otel`
continues to own OTEL logs and traces. `@generic-ai/observability` owns metric
vocabulary, local aggregation, and local query surfaces. A future OTEL export
endpoint requires a follow-on decision covering exporter ownership, export IDs,
dedupe rules, and precedence relative to `@generic-ai/plugin-logging-otel`.

## Consequences

- The implementation starts with contracts, storage/query semantics, security,
  and metric vocabulary instead of a UI-first dashboard.
- Sensitive prompt, model, tool, file, and environment contents are not captured
  by default.
- The package-boundary checker now treats bare `@generic-ai/<noun>` packages as
  a documented surface layer rather than as unrestricted "other" packages.
- Surface entrypoints must stay separated so React/client imports do not pull
  Hono/Node code and server imports do not pull React DOM.
- Starter Hono wiring, hosted adapters, mutating admin tools, payload capture,
  OTEL export, semconv version matrices, and LLM-authored reports remain
  deferred.

## Alternatives Considered

- **Make observability a plugin.** Rejected because this package owns operator
  surfaces, repositories, routes, UI panels, and agent convenience tools rather
  than a single runtime capability wired by the kernel.
- **Put everything in `@generic-ai/plugin-logging-otel`.** Rejected because ADR
  0020 keeps logs/traces separate from metrics, dashboards, and analytics.
- **Use the generic storage contract.** Rejected because the existing contract
  does not express time-range queries, ordering, byte accounting, pinning,
  export markers, duplicate handling, or transactional sweeps.
- **Allow payload capture locally by default.** Rejected because local workspaces
  routinely contain prompts, model outputs, tool arguments/results, file
  contents, `.env` values, credentials, customer data, and proprietary source.
