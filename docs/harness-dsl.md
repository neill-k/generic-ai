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

## Trial Reliability And pass^k

Repeated trials are part of the benchmark contract. `BenchmarkSpec.trials.count`
is the intended trial population, `BenchmarkSpec.minTrials` is the observed
trial floor required before a recommendation can be confident, and
`BenchmarkSpec.smoke` marks a run as a wiring check instead of a claim-bearing
comparison. While the contract stays additive before v1.0, omitted
`trials.count` is interpreted as one trial so older fixtures keep running.

`pass^k` is the reliability estimate for binary primary metrics: given an
observed pass rate `p` across sampled trials, `pass^k = 1 - (1 - p)^k`. The
default `k` is the configured trial count, and specs may override it with
`BenchmarkSpec.trials.passK`. Reports render pass^k next to each candidate so a
single lucky run does not read like a stable architecture result.

Report confidence is explicit:

- `confident_recommendation`: every candidate has at least `minTrials` observed
  trials and metric samples, and any required trace-completeness gate passes.
- `bounded_recommendation`: evidence is sufficient for a bounded recommendation,
  but the run is marked `smoke` or observed fewer trials than configured.
- `insufficient_evidence`: evidence cannot support a recommendation. The hard
  rule is `observed trials < minTrials` always yields `insufficient_evidence`
  when `minTrials` is set on the spec.

Single-run smoke results are allowed for wiring checks, but they cannot produce
a confident architecture recommendation.

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

Effect descriptors also declare reversibility. `irreversible` is the default;
plugins must explicitly opt into `reversible-with-cost` or `reversible-cheap`
and may declare retry semantics. Trace events can carry `reversibility` and
`supersedesEventId`, and reports surface that metadata when it exists instead of
guessing rollback cost from the tool name.

## Three-Tier Benchmark Stack

Generic AI uses the same `MissionSpec` / `BenchmarkSpec` / report pipeline at
three scales:

- Micro: focused function-calling and retrieval scenarios such as
  `examples/bench-tool-calling`.
- Meso: policy-and-tools scenarios such as `examples/bench-policy-tools`, where
  recovery, authority, and tool policy are the behavior under test.
- Macro: full task-environment runs such as `examples/terminal-bench`.

The tiers are adapters around the same evidence contract, not separate product
surfaces. A benchmark layer should emit canonical events and bounded reports
even when its task domain is intentionally small.

## Where To Add Future Work

- Public reusable contracts: `@generic-ai/sdk`.
- Runtime adaptation for compiled harnesses: `@generic-ai/core`, with ADRs for
  cross-package decisions.
- Package-provided protocols, graders, policies, trace exporters, and report
  renderers: future `@generic-ai/plugin-*` or documented package layers.
- Frozen machine-readable external schemas: `contracts/harness/` after the
  typed contract is stable.
