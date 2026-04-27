# @generic-ai/sdk

The framework-facing SDK for Generic AI. This package is the public contract
surface plugin authors and preset authors compile against.

## What lives here

Current SDK contents:

- Canonical config concern types for `framework`, `agent`, `plugin`, `preset`, and the resolved config layer
- Schema-authoring helpers for config contracts and plugin config fragments
- JSON Schema emission interfaces for frozen machine-readable artifacts under `contracts/config/`
- Generic preset and bootstrap contract types used by core and preset packages
- `src/contracts/` for the typed contract surface
- `src/helpers/` for ergonomic contract constructors
- package-level docs and contract tests that keep the surface honest
- Harness DSL, Generic Agent IR, MissionSpec, BenchmarkSpec, protocol ABI,
  TraceEvent, BenchmarkReport, PolicySpec, and HarnessPatch contracts
- AgentHarness contracts, adapter run context, capability-effect descriptors,
  URI/hash artifact references, and typed harness event projections
- Deterministic Harness DSL compiler and evidence report helpers

## Contract surface

The SDK defines the contract families planned in
`docs/planning/02-architecture.md`:

- plugin contracts
- registry contracts
- lifecycle hooks
- config-schema contracts
- scope contracts
- storage contracts
- workspace contracts
- queue contracts
- output-plugin contracts
- sandbox execution contracts for container-backed terminal backends, including policy ceilings, per-stream output truncation, and execution resource reporting
- agents-as-code contracts for declaring, compiling, benchmarking, tracing, and
  reporting on package-composed agent systems
- composable agent harness contracts for adapters, role policy profiles,
  effect-described tools, artifact stores, and canonical harness events

The contract modules are intentionally kernel-agnostic. They do not import
`@generic-ai/core`, and they do not require private kernel knowledge to
implement.

## Helper surface

The helper layer is intentionally small and mostly ergonomic:

- `definePlugin`
- `defineLifecycle`
- `defineConfigSchema`
- `createRegistry`
- `createScope`
- `defineStorage`
- `defineWorkspace`
- `defineQueue`
- `defineOutputPlugin`
- `withAgentHarnessToolEffects`

These helpers do not add policy. They keep plugin author code concise while
staying faithful to the public contract shape.

## Reference documents

- `contracts/sdk/README.md`
- `specs/sdk/README.md`
- `docs/decisions/0004-sdk-contracts.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
- `docs/harness-dsl.md`
- `specs/harness-v0.1/README.md`

