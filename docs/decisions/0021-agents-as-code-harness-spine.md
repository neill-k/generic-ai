# 0021 Agents-As-Code Harness Spine

## Context

The Linear spine `NEI-400` through `NEI-435` reframes Generic AI as a
package-extensible agents-as-code language, compiler, runtime, and evidence
harness. The prior planning pack described a plugin-first framework, but it did
not yet promote Harness DSL, Generic Agent IR, MissionSpec, BenchmarkSpec,
protocol packages, trace artifacts, report boundaries, policy grants, or
controlled harness patches into the repo source of truth.

The new direction also tightens the inference boundary: OpenAI Codex execution
should use the same Pi provider path that Pi uses for `openai-codex`, not a
parallel direct OpenAI client path.

## Decision

Generic AI's public launch spine is:

```text
Harness DSL -> Generic Agent IR -> runtime/packages -> traces/evals/reports
```

`@generic-ai/sdk` owns the public agents-as-code contract surface:

- Harness DSL and Generic Agent IR types,
- protocol package ABI,
- MissionSpec and BenchmarkSpec,
- TraceEvent and artifact references,
- BenchmarkReport and recommendation boundaries,
- PolicySpec, CapabilityGrant, and HarnessPatch contracts,
- deterministic compile and report helper functions.

`@generic-ai/core` may consume compiled harness contracts and expose reference
benchmark runtime helpers, but it must not own package-specific protocol,
policy, grader, trace exporter, or report renderer semantics.

Architecture Lab is the flagship proof and demo surface built on the platform.
It is not the platform boundary.

The `openai-codex` runtime adapter now uses Pi's provider machinery:
`AuthStorage`, `ModelRegistry`, and `createAgentSession`. A runtime API key is
optional when Pi-managed auth already exists in the configured agent directory.

## Consequences

- The planning pack, package-boundary docs, SDK README, core README, and root
  README now use the same agents-as-code vocabulary.
- `contracts/harness/` stays reserved for frozen machine-readable contracts
  after the typed v0.1 surface stabilizes.
- `specs/harness-v0.1/` is the normative v0.1 behavior spec for the language
  boundary.
- Reports must separate observations, inferences, recommendations, and
  insufficient evidence.
- Underpowered single-run smoke checks cannot produce confident architecture
  recommendations unless a BenchmarkSpec explicitly opts into that behavior.
- The direct `openai` dependency is removed from `@generic-ai/core`; Pi remains
  the provider/runtime substrate.

## Alternatives Considered

### Keep Generic AI as only a plugin-first runtime

Rejected. The plugin-first runtime is necessary but not sufficient for reusable
agent-system design. The new spine needs a language, compiler, and evidence
surface so teams can compare package-composed architectures.

### Put the Harness DSL compiler and benchmark semantics entirely in core

Rejected. Core can consume compiled contracts and run reference trials, but
SDK-owned contracts and package-owned extensions keep the kernel minimal.

### Freeze JSON Schema first

Rejected for v0.1. The TypeScript contract and spec need to stabilize before
machine-readable external schemas are frozen in `contracts/harness/`.

### Continue using the direct OpenAI Responses client for `openai-codex`

Rejected. The public runtime path should match Pi's OpenAI Codex provider
method so auth, model resolution, and session behavior stay aligned with the
underlying runtime.
