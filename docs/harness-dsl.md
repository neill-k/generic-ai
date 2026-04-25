# Harness DSL And Evidence Harness

Generic AI is now framed as a package-extensible agents-as-code language,
compiler, runtime, and evidence harness.

The layers are:

```text
Harness DSL -> Generic Agent IR -> runtime/packages -> traces/evals/reports
```

## What Ships In v0.1

- `@generic-ai/sdk` exports the Harness DSL, Generic Agent IR, protocol ABI,
  MissionSpec, BenchmarkSpec, TraceEvent, BenchmarkReport, PolicySpec, and
  HarnessPatch contract types.
- `compileHarnessDsl()` validates package, agent, space, protocol, and artifact
  references before runtime execution.
- `runHarnessBenchmark()` in `@generic-ai/core` consumes compiled harnesses and
  runs trials through `GenericAILlmRuntime`.
- The default `openai-codex` runtime path uses Pi's `openai-codex` provider
  machinery: `AuthStorage`, `ModelRegistry`, and `createAgentSession`.
- `examples/harness-shootout` provides the first package-composed benchmark
  fixture and walkthrough.

## Recommendation Boundary

Reports are evidence-backed, not marketing claims. They separate:

- observations: facts collected from traces, artifacts, metrics, and trials,
- inferences: interpretation of those facts,
- recommendations: bounded suggestions,
- insufficient evidence: cases where the data cannot support a confident claim.

Single-run smoke results are allowed for wiring checks, but they cannot produce a
confident architecture recommendation unless the BenchmarkSpec explicitly opts
into that behavior.

## Authority Boundary

Policy is an SDK contract plus plugin/runtime enforcement surface, not a
kernel-owned interpreter. The v0.1 model includes `PolicySpec`,
`CapabilityGrant`, `RunScopedAuthorityGrant`, and `PolicyDecisionRecord` so
package capabilities can declare grants, runtime decisions can be traced, and
authority expansion can be reviewed through patch flows before it is applied.

## Where To Add Future Work

- Public reusable contracts: `@generic-ai/sdk`.
- Runtime adaptation for compiled harnesses: `@generic-ai/core`, with ADRs for
  cross-package decisions.
- Package-provided protocols, graders, policies, trace exporters, and report
  renderers: future `@generic-ai/plugin-*` or documented package layers.
- Frozen machine-readable external schemas: `contracts/harness/` after the
  typed contract is stable.
