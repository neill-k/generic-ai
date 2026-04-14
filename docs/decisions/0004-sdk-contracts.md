# 0004 — SDK contract surface for plugins, registries, and lifecycle

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-308` (KRN-01)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/planning/04-agent-ready-mapping.md`
  - `docs/package-boundaries.md`

## Context

`KRN-01` is the contract-freeze point for the framework. The planning pack
requires the SDK to expose the public-facing contract surface that plugins and
presets compile against, while keeping the kernel minimal and replaceable.

We need the first SDK pass to answer a very specific question: what can a
plugin author rely on without importing `@generic-ai/core` or knowing anything
about private kernel internals?

The answer for this issue is:

- plugin manifests
- plugin runtime/lifecycle context
- registries
- config schemas
- scope
- storage
- workspace
- queue
- output plugins
- small typed helpers for constructing those contracts

## Decision

### Contract-first SDK, kernel-agnostic surface

`@generic-ai/sdk` is the home for the public contract layer. The package now
defines the contracts directly in `packages/sdk/src/contracts/` and the
matching helpers in `packages/sdk/src/helpers/`.

The contract families are intentionally small and intentionally generic:

- `PluginManifest` and `PluginContract`
- `RegistryContract`
- `LifecycleHooks`
- `ConfigSchemaContract`
- `Scope`
- `StorageContract`
- `WorkspaceContract`
- `QueueContract`
- `OutputPluginContract`

Each contract carries a stable `kind` field where that improves machine
readability. The runtime context passed to plugins includes only the services
they need to author against the public surface: scope, config, registries, and
optional storage/workspace/queue adapters.

### No kernel imports, no hidden `pi` dependency

This SDK pass deliberately does not import `@generic-ai/core`. It also does not
pull in `pi` just to re-export primitives early. That boundary stays reserved
for the kernel work tracked in `KRN-08`.

The aim here is to keep the public authoring surface easy to adopt today while
leaving room for later direct `pi` exposure if that proves useful.

### Small helpers, not policy engines

The helper layer is deliberately conservative:

- `definePlugin`
- `defineLifecycle`
- `defineConfigSchema`
- `createRegistry`
- `createScope`
- `defineStorage`
- `defineWorkspace`
- `defineQueue`
- `defineOutputPlugin`

These helpers keep plugin code concise and type-safe, but they do not introduce
extra framework policy. They are identity helpers except where a small amount
of normalization is genuinely useful, such as registry and scope creation.

### Contract docs live beside the package

The contract freeze is documented in both:

- `contracts/sdk/README.md`
- `specs/sdk/README.md`

Those documents mirror the package surface so that future contract changes have
a stable review target outside the implementation package.

### Test proof

`packages/sdk/src/contracts/sdk-contracts.test.ts` demonstrates that a sample
plugin can implement the full public surface without private kernel knowledge.
The test exercises:

- manifest and dependency declaration
- config schema parsing
- lifecycle hooks
- registry registration
- scope creation
- storage, workspace, and queue adapters
- output finalization

## Consequences

### Positive

- Plugin authors can compile against the SDK without depending on kernel
  internals.
- The contract surface is explicit and reviewable before kernel implementation
  begins.
- The package has a clear place for future helper growth without forcing a
  heavyweight compatibility wrapper.
- Contract tests now cover the intended authoring story.

### Negative

- The SDK surface is necessarily opinionated about the first wave of framework
  concepts, so future simplification will need a successor ADR.
- The current helpers are intentionally lightweight; more advanced validation or
  composition logic will need to land later if the ecosystem asks for it.
- Because the main barrel export is owned elsewhere, consumers should expect a
  follow-up integration step before the package is fully ergonomic from its
  root entrypoint.

## Alternatives considered

### Put contracts in `@generic-ai/core`

Rejected because the planning pack treats the kernel as the orchestration layer,
not the owner of the public plugin contract surface. Putting the contracts in
core would make plugins depend on the kernel too early.

### Add a schema library dependency now

Rejected for this scope. A validation library such as Zod or Ajv would add
dependency churn before the contract shape itself has settled. The current
`ConfigSchemaContract` keeps the schema machine-readable without forcing a
specific validator.

### Hide everything behind a large compatibility layer

Rejected because the planning pack explicitly says not to hide `pi` behind a
heavy wrapper and not to make the framework harder to hack. The SDK should be a
thin, readable contract layer.

## Cross-references

- Package README: `packages/sdk/README.md`
- Contract freeze docs: `contracts/sdk/README.md`
- Behavioral spec: `specs/sdk/README.md`
- Planning baseline: `docs/planning/02-architecture.md`
- Package boundaries: `docs/package-boundaries.md`

