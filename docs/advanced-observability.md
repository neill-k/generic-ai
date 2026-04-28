# Advanced Observability Roadmap

## Why

Generic AI already has a baseline observability package:
`@generic-ai/plugin-logging-otel` consumes kernel events and turns them into
structured logs and OTEL-shaped spans. That is enough for phase-1 tracing and
debugging, but it is not the same thing as product-grade observability.

`DEF-06` exists to keep richer metrics, dashboards, and analytics visible
without coupling them to the first local-first runtime. This document is the
resume plan for that deferred track.

## Current Baseline

- The kernel emits canonical lifecycle events for runs, sessions, delegation,
  tools, and terminal outcomes.
- `@generic-ai/plugin-logging-otel` can ingest those events and retain bounded
  in-memory log/span snapshots or forward records to caller-provided sinks.
- The logging plugin intentionally avoids owning dashboards, metrics catalogs,
  product analytics, retention, or backend-specific exporter pipelines.
- The starter preset includes the logging package as a baseline capability, not
  as an all-in-one observability product.
- ADR 0029 resumes this track through `@generic-ai/observability` as a public
  surface package with metadata-only ingestion, a package-owned repository
  contract, bounded metric catalog, read-only routes, deterministic reports, and
  deferred payload capture plus OTEL export endpoints.

## Decision Summary

- Keep the kernel event stream as the source of observable runtime facts. Do not
  add dashboard, analytics, or metrics aggregation responsibilities to the
  kernel.
- Treat `@generic-ai/plugin-logging-otel` as the baseline logs/traces adapter.
  It may grow exporter wiring, but product-grade metrics and dashboards should
  be separate optional surfaces.
- Use OpenTelemetry as the vendor-neutral interchange model for metrics,
  traces, logs, and resource attributes.
- Model advanced observability in three layers:
  1. framework telemetry, which belongs to Generic AI packages;
  2. operator dashboards, which belong to optional examples, docs, or adapter
     packages;
  3. product analytics, which belongs to framework consumers unless Generic AI
     later ships an explicitly optional analytics plugin.
- Align GenAI-specific runtime spans and metrics with OpenTelemetry GenAI
  semantic conventions, while treating those conventions as development-stage
  until OpenTelemetry marks them stable.
- Keep prompt content, tool inputs, tool outputs, and memory contents out of
  default metrics and dashboard payloads. Sensitive payload capture should be an
  explicit opt-in with redaction hooks.

## Metric Families To Add Later

The first metrics pass should define a stable, low-cardinality vocabulary before
any dashboard work starts.

| Family | Example questions | Notes |
| --- | --- | --- |
| Run/session lifecycle | How many runs start, complete, fail, cancel, or time out? How long do they take? | Derive from canonical events and keep status/mode attributes bounded. |
| Delegation | Which agents delegate, how deep do trees get, and where do child sessions fail? | Avoid unbounded task text or prompt attributes. |
| Tool usage | Which capability/tool classes are used, how long do calls take, and where do they fail? | Attribute by package, tool name, operation class, and status. |
| Queueing | How long do async runs wait, execute, retry, and drain? | Future external queue plugins should map to the same contract. |
| Storage/messaging/memory | Which operations dominate latency or error rates? | Prefer operation class and backend type over user-provided keys. |
| Model calls | Which providers/models are used, what is latency, and what token volume is reported? | Use OpenTelemetry GenAI fields when available; do not estimate tokens unless explicitly configured. |
| Governance/sandbox outcomes | Which policy decisions, denials, resource ceilings, and sandbox terminations occur? | Connect to `docs/runtime-governance.md` and sandbox result metadata. |

## Dashboard Roadmap

The first dashboard-facing slice should stay backend-neutral:

1. Define a framework metrics contract and recommended attribute set.
2. Add an OTEL metrics adapter or extend the logging package only if doing so
   does not make it own dashboard/product concerns.
3. Document a collector-first deployment shape so services can export to a local
   or sidecar OpenTelemetry Collector for batching, filtering, and backend
   routing.
4. Provide one reference dashboard specification, not a hard dependency on a
   hosted vendor. The dashboard should answer:
   - current run/session health;
   - agent and delegation failure hot spots;
   - tool latency and error hot spots;
   - queue backlog and drain time;
   - model token and latency trends when providers report them;
   - sandbox and governance denials or resource ceilings.
5. Keep product analytics separate from operator observability. Usage funnels,
   account-level reporting, and experimentation belong to the consuming
   application unless Generic AI later adds a dedicated optional analytics
   plugin.

## Attribute And Cardinality Rules

Future metrics and dashboards should follow these rules:

- Always include bounded framework dimensions such as package name, capability
  kind, operation class, status, run mode, and configured backend type.
- Prefer stable ids only when they are needed for correlation. Do not make
  session ids, run ids, prompt hashes, file paths, or user-provided labels
  default metric dimensions.
- Use traces and logs for high-cardinality drill-down. Use metrics for aggregate
  health and trend views.
- Treat prompt, output, memory, and file content as sensitive. They are never
  emitted by default.
- Version any Generic AI-specific metric vocabulary before exposing it as a
  public package contract.

## Resume Order

When this deferred track resumes, split it into these slices:

1. **Metric vocabulary and contracts**
   - Add a docs-first metric catalog with names, units, attributes, and source
     events.
   - Decide whether the first contract lives in `@generic-ai/sdk`,
     `@generic-ai/plugin-logging-otel`, or a new optional metrics package.
   - Add tests that lock event-to-metric mapping for the selected source events.
2. **OTEL metrics adapter**
   - Emit metrics using OpenTelemetry-compatible instruments and units.
   - Keep exporter configuration backend-neutral and compatible with a Collector
     pipeline.
   - Add redaction and high-cardinality guardrails before release.
3. **Reference operator view**
   - Publish a dashboard specification or runnable example that consumes the
     emitted telemetry.
   - Cover local development and hosted deployment shapes separately.
   - Document the minimal signal set needed for production readiness.
4. **Product analytics extension**
   - Decide whether analytics remains consumer-owned or becomes an optional
     `@generic-ai/plugin-*` package.
   - Keep account/user/product-event semantics out of the kernel and baseline
     OTEL adapter.

## Exit Criteria For The Future Track

The advanced observability track is ready to close when:

- Generic AI has a documented metric catalog with stable names, units, and
  low-cardinality attributes;
- metrics cover run/session lifecycle, delegation, tool calls, queueing, storage
  and memory operations, model calls, and governance/sandbox outcomes;
- exported telemetry can flow through a vendor-neutral OpenTelemetry Collector
  pipeline;
- at least one reference operator dashboard or dashboard specification exists;
- product analytics are explicitly classified as consumer-owned or implemented
  in a separate optional plugin;
- default telemetry avoids prompt, output, memory, file-content, and secret
  leakage.

## Source Anchors

- [OpenTelemetry overview](https://opentelemetry.io/docs/specs/otel/overview/)
- [OpenTelemetry metrics semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/)
- [OpenTelemetry GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
