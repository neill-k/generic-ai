# 0031. Fault-Injection Benchmark Contracts

## Status

Accepted.

## Context

NEI-512 adds a benchmark evidence surface for degraded dependencies: tool
timeouts, stale memory, misleading retrieval, schema drift, partial payloads,
and service faults. The planning pack keeps the kernel minimal and package
boundaries explicit. Plugins depend on `@generic-ai/sdk`, not `@generic-ai/core`,
so boundary-specific fault injectors cannot become kernel business logic.

Adjacent benchmark work has already added trace-backed reports, Terminal-Bench
artifact evidence, DAG navigation profiles, and repeated-run reliability
summaries. Fault injection should build on that evidence harness rather than
claim external benchmark score movement without a same-profile before/after
run.

## Decision

Generic AI will define fault-injection benchmark contracts in `@generic-ai/sdk`.
`BenchmarkSpec` may include `faultInjections`, each described by a
`FaultInjectionSpec` with boundary, perturbation, target reference, expected
behavior, severity/timing metadata, and an optional first violated contract.

Trial results may attach `FaultInjectionObservation` records. The SDK report
helper aggregates those observations into planned and observed case counts,
containment rate, recovery rate, overclaim-prevention rate, and first violated
contracts. When configured cases have no observations, reports record an
insufficient-evidence gap instead of silently treating the benchmark as
successful.

`@generic-ai/core` may surface configured cases to benchmark runtimes and feed
observations into reports, but live injectors stay package-owned. Tool, memory,
retrieval, web, MCP, messaging, storage, and sandbox packages should implement
their own hooks or harness adapters against the SDK contract.

## Consequences

- Fault-injection evidence is portable across benchmark adapters and does not
  require core to import plugin code.
- Reports can distinguish safe containment from unsupported final success
  claims.
- The first fixture in `examples/harness-shootout/fault-injection/` is an
  evidence-quality and benchmark-coverage improvement only. It is not a
  Terminal-Bench reward, success, pass-rate, or external SOTA improvement claim.
- Follow-on plugin work can add concrete runtime injectors while preserving the
  same report shape.

## Alternatives Considered

- Put injector hooks directly into core. Rejected because it would make the
  kernel own plugin-specific failure modes and violate the planning boundary.
- Add only example JSON without SDK types. Rejected because adapters and report
  renderers need a shared contract to compare results.
- Treat missing fault observations as failed metric zero. Rejected because
  missing observations are a measurement gap, not proof of unsafe behavior.
