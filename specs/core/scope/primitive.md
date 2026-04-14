# Scope Primitive

This spec defines the generic `Scope` primitive used by the framework kernel and the framework-facing SDK.

## Goals

- Provide a first-class execution boundary that is not tenant-specific or product-specific.
- Keep scope immutable so it can move across bootstrap, session, plugin, and config boundaries without accidental mutation.
- Make propagation explicit through helper functions rather than hidden global state.

## Contract

A `Scope` is a frozen object with these fields:

- `id`: unique identifier for the current scope
- `rootId`: identifier of the root scope in the lineage
- `parentId`: identifier of the direct parent scope when this is not a root scope
- `lineage`: ordered list of scope ids from root to current scope
- `kind`: optional free-form category string
- `label`: optional human-readable label
- `metadata`: optional shallow frozen record for framework-agnostic annotations

The primitive is intentionally generic:

- It does not encode tenant identity.
- It does not encode authorization state.
- It does not encode any product-specific hierarchy.

## Factory Behavior

- `createRootScope()` creates a root scope with a single-item lineage.
- `createChildScope(parent, input)` creates a new scope whose lineage extends the parent lineage by one id.
- `createScope(input)` creates a root scope when no parent is supplied and a child scope when a parent is supplied.

When callers omit an id, the factory generates one.

## Propagation Rules

Kernel-side propagation helpers should treat scope as carrier data on plain objects:

- The carrier property is named `scope`.
- Helpers must not mutate the source object.
- Helpers must preserve an existing scope when one is already present.
- Helpers may derive a child scope from a parent scope when requested explicitly.

## Expected Integration Points

The current implementation is isolated to the scope package boundaries. Future kernel work should thread `Scope` through:

- top-level bootstrap input and bootstrap result objects
- root session creation and child-session creation
- plugin manifest and plugin execution context objects
- config resolution and validation results

No bootstrap/session call site exists yet in this workspace slice, so the contract is defined here first and wired later.

## Verification

The contract is covered by package tests in:

- `packages/sdk/test/scope/scope.test.ts`
- `packages/core/test/scope/scope-propagation.test.ts`

