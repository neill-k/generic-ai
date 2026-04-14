# 0011. Direct `pi` integration with a thin adapter boundary

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-313` / `KRN-08`
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/package-boundaries.md`

## Context

The planning pack says Generic AI should build on `pi`, expose `pi` primitives
directly where practical, and avoid a heavy compatibility wrapper. The practical
upstream source is `@mariozechner/pi-coding-agent@0.67.1`, which already
provides the programmatic embedding API, extension contracts, session runtime,
and built-in tool set.

The kernel still needs a small internal seam so it can translate `pi` into the
framework's own bootstrap, session, and plugin-host state. The risk in this
issue is creating a second abstraction layer that duplicates `pi` instead of
surfacing it.

## Decision

Generic AI now treats `@mariozechner/pi-coding-agent` as the direct runtime
source and re-exports the stable authoring/runtime primitives from
`packages/sdk/src/pi/**`.

The direct surface is intentionally limited to the pieces that authors and
embedders should reasonably use themselves:

- agent/runtime creation
- session and runtime objects
- session manager and resource loader entrypoints
- extension contracts and tool contracts
- built-in coding tools
- `Skill` and `PromptTemplate`

The kernel-facing translation layer lives in `packages/core/src/runtime/**` and
is only responsible for adapting those `pi` primitives into framework state.
It does not introduce a separate framework-specific replacement API.

The boundary explicitly keeps lower-level `pi-agent-core`, `pi-ai`, TUI, and
session-persistence details behind the adapter so the framework does not freeze
those implementation details as public contract.

## Consequences

- Framework authors can import `pi` primitives directly from the SDK surface
  instead of learning a second wrapper API.
- The kernel keeps a narrow adapter layer for session/bootstrap translation
  without owning `pi` internals.
- Future runtime work can widen or narrow the direct surface by editing one
  documented seam instead of untangling wrapper code spread across the kernel.

## Alternatives Considered

### Rewrap `pi` behind a framework-specific runtime facade

Rejected because it would duplicate the upstream API, obscure the direct source
of truth, and make the framework harder to keep aligned with `pi`.

### Re-export every `pi` symbol from the SDK

Rejected because the goal is a thin boundary, not a wholesale mirror of the
upstream package. Only the primitives needed for authoring and embedding are
directly exposed.

### Hide `pi` entirely behind kernel-only adapters

Rejected because the planning pack explicitly asks for direct exposure where it
is practical, and hiding the runtime would create avoidable churn for plugin and
preset authors.
