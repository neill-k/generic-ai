# 0006 — Generic Scope primitive and propagation helpers

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-310` (`KRN-03`)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/package-boundaries.md`
- Related spec:
  - `specs/core/scope/primitive.md`

## Context

`KRN-03` asks for a first-class `Scope` primitive that is available from bootstrap through plugin execution, stays generic, and can serve as the common execution boundary for runs, plugins, and config. The planning docs also make it clear that scope should not become tenant-specific or product-specific.

At this point in the repo, the bootstrap/session call sites that will eventually carry scope do not exist yet. We still need a stable contract now so later kernel work does not invent a different shape for each consumer.

## Decision

### Scope is a generic immutable primitive

`Scope` is a frozen structural object with:

- `id`
- `rootId`
- `parentId` when the scope is derived
- `lineage`
- optional `kind`
- optional `label`
- optional shallow-frozen `metadata`

The primitive is intentionally free of tenant semantics, auth semantics, or product-specific hierarchy.

### Scope lives at the SDK contract boundary

The public contract shape is defined in `@generic-ai/sdk`, because plugins and presets need to compile against the scope shape without importing kernel internals. The kernel can then use the same shape internally when it threads scope through bootstrap and session orchestration.

### Core owns propagation helpers

The kernel-side scope module owns the helpers that attach scope to plain objects and derive child scopes for execution flows:

- `withScope`
- `withChildScope`
- `ensureScope`
- `inheritScope`
- `getScope`
- `hasScope`

These helpers are intentionally object-oriented rather than framework-specific. They work with bootstrap results, session objects, plugin execution inputs, and config resolution payloads without imposing a kernel-only envelope.

### Propagation is explicit, not implicit

We reject hidden global scope state. Callers must pass scope around explicitly or attach it to a carrier object. That keeps propagation visible in tests and keeps later async/session work from depending on ambient mutable state.

## Consequences

Positive:

- Later kernel work has a stable scope shape to target instead of inventing one inside bootstrap or sessions.
- The SDK can expose the same generic contract to plugins and presets without pulling in kernel internals.
- The core helpers make it easy to thread scope through plain objects now and through richer session objects later.

Trade-offs:

- The current implementation is duplicated across the SDK and core package boundaries until the root barrel exports are wired up.
- `ScopeKind` is intentionally wide (`string`) to stay generic, which means product-level conventions will have to be documented separately if they emerge.

## Alternatives Considered

- **Tenant-specific scope model.** Rejected because the planning pack explicitly says scope should outlive any single tenancy model.
- **Mutable ambient context.** Rejected because it would make propagation harder to reason about and would couple future session work to hidden global state.
- **Wait for bootstrap/session call sites before defining scope.** Rejected because later kernel work needs a stable contract now, not a shape invented ad hoc during implementation.

## Notes For The Next Kernel Issues

The implementation in this workspace does not yet wire scope into bootstrap or sessions. The next kernel issues should thread the scope object through:

- top-level bootstrap input/output
- root and child session creation
- plugin execution context
- config discovery and validation results

