# 0037. PROV-Style Evidence Bundles

## Status

Accepted.

## Context

ADR 0030 added `@generic-ai/observability` as a local-first surface for runs,
traces, metrics, reports, and read-only operator panels. That package keeps OTEL
ownership narrow: `@generic-ai/plugin-logging-otel` owns logs and traces, while
`@generic-ai/observability` owns local aggregation, query, and deterministic
reports.

The research-harness repositioning needs one more layer. OTEL describes runtime
causality well, but evidence-grade reports also need semantic relationships:
which observation came from which event, which inference was derived from which
artifact or policy decision, and which agent/activity produced each evidence
entity.

## Decision

Generic AI will emit a PROV-style evidence bundle alongside OTEL-shaped runtime
telemetry for research-harness runs.

The bundle is JSON-LD-like and uses the following model:

- **Entities** represent evidence objects: run records, canonical events,
  harness projections, artifacts, policy decisions, trace events, report
  observations, report inferences, recommendations, and insufficient-evidence
  findings.
- **Activities** represent work that happened over time: the run itself,
  canonical event emission, projection creation, trace-event activity, artifact
  creation, policy evaluation, and report generation.
- **Agents** represent responsible actors: the Generic AI runtime, root harness
  agent, event sources, policy actors, and package/protocol actors when the trace
  provides them.
- **Derivations** connect entities to the evidence they came from, including
  event-to-projection, event-to-report, artifact-to-report, and
  policy-decision-to-report relationships.

OTEL remains the runtime-causality layer. PROV-style bundles are the
evidence-semantics layer. They are allowed to reference OTEL span IDs or trace
event IDs when present, but they must not require OTEL to be the only evidence
handle.

`@generic-ai/observability` owns the first exporter because it already owns
metadata-only local traces and deterministic reports. The exporter must consume
existing observability trace/report inputs and must not mutate SDK harness types.

## Consequences

- Research reports can cite stable provenance entity IDs instead of only span
  IDs or prose bullets.
- The observability package can add provenance artifacts without taking over
  OTEL span emission from `@generic-ai/plugin-logging-otel`.
- Payload capture stays disabled by default. Provenance entities summarize and
  point to existing metadata/artifact references rather than storing sensitive
  prompt, model, file, environment, or tool payload contents.
- Report-renderer citation upgrades can happen later against the same entity
  IDs without a schema break.

## Alternatives Considered

### Use OTEL spans as the only evidence model

Rejected. Spans are good for runtime timing and causality, but report
observations and inferences need evidence semantics that can point at events,
artifacts, policies, and insufficient-evidence findings uniformly.

### Add provenance fields directly to SDK harness types now

Rejected for this milestone. The observability package can derive bundles from
canonical traces and reports without forcing W3/W4 SDK schema work to merge at
the same time.

### Capture full payloads inside the provenance bundle

Rejected. ADR 0030 keeps payload capture disabled by default. Provenance should
preserve evidence relationships without becoming a secret or customer-data sink.
