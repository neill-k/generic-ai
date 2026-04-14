# Canonical Event Stream Contract

This contract freezes the event taxonomy and stream surface for the Generic AI
kernel. It is the source-of-truth interface for plugin authors, logging
consumers, and any future transport that wants to observe run/session
lifecycle state.

## Core Event Taxonomy

The canonical stream carries three kernel-owned lifecycle families and one
open plugin extension family:

- `run.*` for root run lifecycle.
- `session.*` for session lifecycle, including child-session visibility.
- `delegation.*` for delegation lifecycle visibility.
- `plugin.<pluginId>.<event>` for plugin-defined extension events.

Canonical core names are fixed:

- `run.created`
- `run.started`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `session.created`
- `session.started`
- `session.completed`
- `session.failed`
- `session.cancelled`
- `session.child.created`
- `session.child.started`
- `session.child.completed`
- `session.child.failed`
- `session.child.cancelled`
- `delegation.requested`
- `delegation.accepted`
- `delegation.rejected`
- `delegation.completed`
- `delegation.failed`
- `delegation.cancelled`

## Event Shape

Every emitted event is immutable and includes:

- `eventId`: stable event identifier.
- `sequence`: monotonic stream sequence, starting at `1`.
- `occurredAt`: ISO timestamp.
- `name`: one of the canonical names above or a plugin extension name.
- `scopeId`: execution scope boundary.
- `runId`: root run identifier.
- `rootSessionId`: root session identifier for the run.
- `sessionId`: current session identifier.
- `parentSessionId?`: parent session when the event concerns a child session.
- `delegationId?`: delegation correlation when present.
- `origin`: `{ namespace: "core" | "plugin", pluginId?, subsystem? }`.
- `data`: plugin-defined opaque payload.

## Stream Surface

The contract exposes one stream object:

- `emit(event)` publishes an event and returns the sealed event instance.
- `subscribe(listener, filter?)` registers a subscriber and replays history
  by default.
- `snapshot(filter?)` returns the buffered history.
- `close()` shuts the stream down and detaches listeners.

## Subscription Filter

Subscribers may filter on:

- `names`
- `families`
- `namespaces`
- `pluginId`
- `fromSequence`
- `predicate`

## Extension Rules

- Plugin extension events must use the `plugin.<pluginId>.<event>` namespace.
- Core lifecycle names are frozen and may only be extended by successor ADRs.
- The payload shape is intentionally open so OTEL, logging, and future
  transport plugins can project their own data without kernel schema churn.

## Kernel Integration Hooks

The kernel is expected to emit core lifecycle events at these boundaries:

- root run allocation and start
- session creation and start
- child session creation and start
- delegation request, accept/reject, and completion
- session and run completion, failure, or cancellation

The session orchestrator is not yet wired in this scope, so consumers should
treat the stream itself as the stable integration point for now.
