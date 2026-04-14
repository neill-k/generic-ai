# Core Canonical Event Stream Spec

This spec describes the runtime behavior of the canonical run/session event
stream used by `@generic-ai/core`.

## Goals

- expose a single observable stream for run/session lifecycle
- keep plugin observation separate from kernel internals
- preserve child-session and delegation visibility
- make logging and OTEL consumers simple to build

## Required Behavior

1. Events are immutable once emitted.
2. `sequence` is monotonic and starts at `1`.
3. `subscribe()` replays buffered history by default.
4. Late subscribers see the same stream order as live subscribers.
5. Filtering is applied before replay and before live delivery.
6. Subscriber failures do not corrupt the stream; they are routed to the
   stream error hook when one is registered.
7. Closing the stream prevents further subscriptions or emits.

## Event Ordering

The expected lifecycle order for a root run is:

1. `run.created`
2. `run.started`
3. `session.created`
4. `session.started`
5. child-session and delegation events as work is fanned out
6. `session.completed` or `session.failed`
7. `run.completed` or `run.failed`

Cancellation may occur at either the run or session layer and should emit the
matching `*.cancelled` event immediately when observed.

## Child Session And Delegation Hooks

Until the session orchestrator lands, kernel callers should treat the following
as the expected hook points:

- emit `delegation.requested` when a plugin asks for child work
- emit `session.child.created` when the child session is allocated
- emit `session.child.started` when the child begins execution
- emit `session.child.completed`, `session.child.failed`, or
  `session.child.cancelled` when the child resolves
- emit the matching delegation completion event when the delegation itself
  resolves

These hooks are intentionally separate so a plugin can observe delegation
policy independently from child-session runtime state.

## Plugin Extension Behavior

- Plugin events use the `plugin.<pluginId>.<event>` namespace.
- Plugin events may be subscribed to with the same filters as core events.
- Plugin payloads are intentionally opaque; the stream only guarantees the
  common envelope and ordering semantics.

## Implementation Notes

The current implementation is self-contained inside the `packages/core/src/events`
tree. When session orchestration lands, the kernel should wire its lifecycle
boundaries directly into this stream rather than introducing a second
observer path.
