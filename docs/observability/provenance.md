# Provenance Bundles

Generic AI uses two complementary evidence models:

- OTEL-shaped telemetry explains runtime causality, timing, and operational
  traces.
- PROV-style provenance bundles explain evidence semantics: which entities were
  produced, which activities produced them, which agents were responsible, and
  which entities were derived from other evidence.

`@generic-ai/observability` owns the first provenance exporter because it already
stores metadata-only traces and deterministic reports. The exporter consumes an
`ObservabilityTraceRecord` plus an optional `ObservabilityReport` and emits a
JSON-LD-like bundle with:

- `entities` for run records, events, projections, artifacts, policy decisions,
  trace events, observations, inferences, and insufficient-evidence findings;
- `activities` for runs, event emission, projection creation, artifact creation,
  policy evaluation, trace events, and report generation;
- `agents` for the runtime, observability reporter, event sources, policy
  actors, and trace actors;
- `derivations` connecting generated entities to the evidence they used.

The bundle is intentionally metadata-only. It includes payload posture, payload
kind, byte counts, artifact URIs, hashes, policy decisions, and report text, but
it does not embed raw prompt, model, file, environment, or tool payload content.

Server users can retrieve the derived artifact from
`GET /runs/:id/provenance`. Package users can call:

```ts
import { createProvenanceBundle } from "@generic-ai/observability/provenance";

const bundle = createProvenanceBundle({ trace, report });
```
