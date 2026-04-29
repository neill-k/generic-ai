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
  machinery exposed through `@generic-ai/sdk/pi`: `AuthStorage`,
  `ModelRegistry`, and `createAgentSession`.
- `examples/harness-shootout` provides the first package-composed benchmark
  fixture and walkthrough.

## Recommendation Boundary

Reports are evidence-backed, not marketing claims. They separate:

- observations: facts collected from traces, artifacts, metrics, and trials,
- inferences: interpretation of those facts,
- recommendations: bounded suggestions,
- insufficient evidence: cases where the data cannot support a confident claim.

BenchmarkSpec can declare metric definitions with higher-is-better,
lower-is-better, or informational direction. Report helpers use those directions
when choosing bounded recommendations, and a missing primary metric sample stays
`insufficient_evidence` rather than being treated as zero.

Single-run smoke results are allowed for wiring checks, but they cannot produce a
confident architecture recommendation unless the BenchmarkSpec explicitly opts
into that behavior.

BenchmarkSpec can also attach a repeated-run reliability profile. The profile is
optional and report-only: it records success thresholds, pass@k cuts,
perturbation labels, retry accounting, skipped/excluded trials, and bounded
failure severity without replacing the primary metric. Reports use it to make
consistency, variance, robustness, and failure severity visible when two
candidates have similar average scores.

## Fault-Injection Benchmarks

`BenchmarkSpec.faultInjections` describes degraded boundary cases a benchmark
run should exercise. Each `FaultInjectionSpec` names the boundary, perturbation,
target reference, expected behavior, and optional first violated contract. The
SDK report helper aggregates matching trial observations into planned case
count, observed case count, containment rate, recovery rate,
overclaim-prevention rate, and first violated contracts.

Fault injection is a contract and evidence surface in v0.1. Plugin-owned
injectors for terminal tools, retrieval, memory, web, MCP, messaging, and
storage should implement this contract in their own packages or harness
adapters. Core may pass configured cases into benchmark prompts and reports, but
it must not import plugin-specific fault hooks.

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
