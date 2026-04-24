# 0015. Advanced Observability Beyond OTEL Baseline

Status: accepted

## Context

Generic AI already has a baseline observability surface:

- the kernel emits canonical lifecycle events;
- `@generic-ai/plugin-logging-otel` consumes those events;
- the logging plugin produces bounded log and span records and can forward them
  to caller-provided sinks.

That baseline satisfies the first-wave logging and tracing goal, but `DEF-06`
tracks a different need: richer metrics, operator dashboards, and future
analytics surfaces. Without an explicit decision, future work could either
overload the logging plugin with product responsibilities or push dashboard and
analytics behavior into the kernel.

OpenTelemetry's current model supports separate but correlated traces, metrics,
logs, resources, context propagation, and Collector pipelines. Its GenAI
semantic conventions also define development-stage spans and metrics for model,
tool, retrieval, and agent operations. Those conventions are useful anchors, but
they should be adopted with version awareness until they stabilize.

## Decision

Generic AI keeps advanced observability as an optional layer above the baseline
logs/traces plugin.

- The kernel remains responsible only for stable runtime facts: canonical
  lifecycle events, session context, and run/delegation/tool identifiers.
- `@generic-ai/plugin-logging-otel` remains the phase-1 logs/traces adapter. It
  must not become the owner of dashboards, product analytics, retention, or
  backend-specific operations.
- Future framework metrics should use OpenTelemetry-compatible names, units, and
  low-cardinality attributes, with Generic AI-specific vocabulary documented
  before it becomes a public package contract.
- GenAI model, agent, retrieval, and tool telemetry should align with
  OpenTelemetry GenAI semantic conventions where they fit, while guarding
  against unstable convention churn.
- Operator dashboards should consume exported telemetry rather than private
  kernel hooks.
- Product analytics stay consumer-owned unless a later issue explicitly creates
  an optional analytics plugin.
- The concrete roadmap for resuming `DEF-06` is recorded in
  `docs/advanced-observability.md`.

## Consequences

- The existing package boundaries remain intact: the kernel is not a metrics or
  dashboard engine, and the logging plugin stays replaceable.
- Future metrics work starts with a catalog and attribute rules, not a dashboard
  implementation that bakes in one backend.
- OpenTelemetry Collector support becomes the recommended export/deployment
  shape for production telemetry pipelines.
- Dashboard work can proceed later without changing event-stream contracts, as
  long as the source events carry enough context.
- Product analytics may need a separate package or consumer documentation later,
  because framework telemetry intentionally avoids user/account/product-event
  semantics.

## Alternatives Considered

### Extend `@generic-ai/plugin-logging-otel` into an all-in-one observability product

Rejected because it would make a baseline adapter responsible for dashboards,
analytics, backend retention, and operator workflows. That would make the plugin
less replaceable and blur the distinction between framework telemetry and
product analytics.

### Put metrics aggregation in the kernel

Rejected because the kernel should emit facts, not own observability policy,
storage, or dashboard needs. Metrics aggregation belongs in plugins, adapters,
or external telemetry pipelines.

### Leave advanced observability entirely to framework consumers

Rejected because Generic AI still needs a documented metric vocabulary and
operator guidance. Consumers can own product analytics, but the framework should
define how its runtime emits stable health and performance signals.

### Build a dashboard before defining metrics

Rejected because dashboards should be consumers of a stable signal contract. A
dashboard-first approach would make metric names and cardinality rules
accidental.
