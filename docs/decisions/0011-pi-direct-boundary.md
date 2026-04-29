# 0011. Direct `pi` integration with a thin adapter boundary

- Status: accepted
- Date: 2026-04-13
- Amended: 2026-04-29 (`NEI-555`)
- Amended: 2026-04-29 (research-harness runtime boundary)
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
source and exposes the stable authoring/runtime primitives from the explicit
Pi compatibility surface `@generic-ai/sdk/pi` (`packages/sdk/src/pi/**`).

For the research-harness repositioning, Generic AI chooses a **Pi-first,
pluggable-later** runtime boundary:

- Pi is the only in-tree execution runtime for the current public harness
  surface.
- Generic AI does not add a public cross-runtime adapter contract in this
  milestone.
- The SDK run envelope, canonical events, trace projections, artifact
  references, policy decisions, and report inputs stay runtime-portable.
- Future runtime adapters may be introduced only by a follow-on ADR that names
  the adapter contract, ownership, compatibility tests, and maintenance budget.

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

The research harness compares agentic architecture choices inside a stable
runtime first: role topology, protocol package, tool policy, memory, recovery,
evaluation, and reporting. Cross-runtime comparison is a valid future research
axis, but it is not required for the v0.1/v0.2 harness contract and would widen
the maintenance surface before the harness evidence model is stable.

## Consequences

- Framework authors can import Pi primitives from `@generic-ai/sdk/pi` when
  they intentionally need Pi behavior, while generic framework contracts remain
  Pi-agnostic at `@generic-ai/sdk`.
- The kernel keeps a narrow adapter layer for session/bootstrap translation
  without owning `pi` internals.
- Future runtime work can widen or narrow the direct surface by editing one
  documented seam instead of untangling wrapper code spread across the kernel.
- Benchmark and report artifacts must not assume Pi-specific identifiers as
  their only evidence handles. Runtime-specific details may appear in metadata,
  but canonical events, trace events, artifact references, policy decisions, and
  provenance bundles remain the portable comparison layer.
- No `@generic-ai/runtime-adapter-*` package or root SDK adapter ABI is created
  by this decision. Adding one later requires a new ADR and compatibility tests
  against the existing run envelope and event schema.

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

### Commit to multi-runtime adapters now

Rejected for this milestone. Adapter contracts for Agents SDK, LangGraph,
CrewAI, Agent Framework, or similar engines would be a real product commitment:
they need trace mapping, policy mapping, tool semantics, replay expectations,
documentation, test fixtures, and release support. The current repo evidence
shows the shipped harness value comes from comparing architecture choices over a
stable Pi-backed execution path, so Generic AI keeps the runtime axis stable
while preserving portable evidence artifacts for a later adapter decision.

## Research Notes For NEI-555

Before this amendment, we reviewed external adapter-boundary patterns:

- LangGraph separates graph/runtime abstractions from provider/model wiring.
- OpenAI Agents SDK documents explicit model-provider pathways and adapters
  instead of conflating provider specifics with root agent contracts.
- AutoGen centers model-client abstractions so workflows stay provider-portable.
- CrewAI documents provider-qualified model routing (`provider/model`) with
  explicit provider integrations.

This amendment follows the same principle: runtime-specific APIs stay explicit
and opt-in, while the root SDK contract remains runtime-agnostic.
