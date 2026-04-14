# 0010 - Canonical run envelope and explicit output-plugin boundary

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-315` (`KRN-07`)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/package-boundaries.md`
- Related contract:
  - `contracts/run-envelope/canonical-run-envelope.md`

## Context

`KRN-07` follows the shared event stream and shared run-mode work. The
architecture pack says the kernel should return a small, stable run envelope
and keep final payload shaping in plugins. That means the kernel needs a
canonical control surface now, but it must not become the place where output
schema decisions accrete.

At the same time, the event/run-mode integration points are still landing in
parallel. We need a contract and a local builder/finalizer surface that can be
wired in later without forcing the wrong public shape today.

## Decision

### Run envelope is minimal and stable

The kernel-owned run envelope is intentionally small:

- `runId`
- `rootScopeId`
- `rootAgentId?`
- `mode`
- `status`
- `timestamps`
- `eventStream?`
- `outputPluginId?`
- `output?`

The envelope is immutable once created. It is a stable coordination object,
not the final response schema.

### Output shaping is explicit and delegated

The kernel does not own final payload semantics. Instead:

- the kernel records which output plugin is responsible
- the plugin finalizes its own output envelope
- the kernel carries that output envelope without interpreting the payload

This keeps the boundary explicit and leaves transport- or product-specific
payload details to the output plugin layer.

### Builder and finalizer surfaces are local for now

Because the run/bootstrap integration points are not fully wired yet, the
implementation in this scope exposes local `createRunEnvelope(...)` and
`finalizeRunEnvelope(...)` surfaces in `@generic-ai/core`.

That gives later work a stable target without needing to invent the final
bootstrap API in the same pass.

## Consequences

### Positive

- The kernel has a stable envelope shape that can survive later wiring.
- Output plugins remain the place where final response formatting lives.
- The envelope can be threaded through future run/session/event integration
  without changing its core fields.

### Negative or deferred

- The kernel still does not know the full bootstrap/run finalization story.
- The current implementation is in-memory and local to this scope.
- Event-stream and run-mode plumbing still need to adopt the envelope helper
  surfaces.

## Alternatives Considered

### Put the final payload directly on the run envelope

Rejected because it would blur the kernel/plugin boundary and make the kernel
own response semantics that belong to plugins.

### Make the envelope a transport-specific response object

Rejected because transport shapes should remain replaceable and should not be
hardcoded into the kernel contract.

### Wait for bootstrap and output plugins before defining the envelope

Rejected because the later integration work needs a stable contract now.

## Integration Notes

When the remaining runtime wiring lands, the kernel should:

- create the envelope when a root run starts
- update the envelope status as the shared session tree progresses
- pass the terminal run and selected output plugin into the finalizer
- surface the resulting output envelope without translating its payload

The next issue that touches bootstrap or run execution should consume this
contract rather than inventing a new one.
