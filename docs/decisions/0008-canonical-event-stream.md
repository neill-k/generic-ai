# 0008 — Canonical event stream for run and session lifecycle

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-312` (KRN-05)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/package-boundaries.md`
- Related contracts:
  - `contracts/events/canonical-event-stream.md`
- Related specs:
  - `specs/core/events/canonical-event-stream.md`

## Context

`KRN-04` establishes the shared session machinery, but the repository does
not yet contain a session orchestrator or any runtime wiring into logging,
OTEL, or transport consumers. The architecture plan still requires the
kernel to own a canonical stream for run/session lifecycle, including child
session and delegation visibility, so that plugins can observe execution
without reaching into private kernel internals.

We need the stream surface now for two reasons:

1. The kernel and plugins need a common vocabulary before orchestration and
   transport work fan out in parallel.
2. Logging and observability plugins should be able to subscribe to a stable
   stream without the kernel deciding output schema or transport shape.

This ADR records the decision to make the stream self-contained within the
current scope and to document the integration hooks the session orchestrator
will use later.

## Decision

### Canonical event taxonomy

The canonical stream uses a small frozen taxonomy:

- `run.*` for root run lifecycle.
- `session.*` for session lifecycle, including child-session visibility.
- `delegation.*` for delegation lifecycle visibility.
- `plugin.<pluginId>.<event>` for plugin-defined extensions.

The kernel-owned names are frozen for `KRN-05` and are documented in the
contract/spec pair under `contracts/events/` and `specs/core/events/`.

### Stream surface

The stream is intentionally simple:

- `emit()` seals an immutable event and advances monotonic sequence ordering.
- `subscribe()` replays history by default and supports name/family/namespace
  filters so plugins can observe only the slices they need.
- `snapshot()` exposes buffered history for diagnostics and late joiners.
- `close()` shuts the stream down cleanly.

Subscriber errors are isolated from the kernel path. The stream can report
subscriber failures through an optional error hook, but it does not let one
observer corrupt another observer or mutate the stream state.

### Plugin extension point

Plugins may emit or observe `plugin.<pluginId>.<event>` names through the same
surface. This keeps the stream open for future transports and instrumentation
without forcing a second observer API.

### Self-contained implementation

Because session orchestration is not present yet, the stream implementation
stays self-contained in both `packages/sdk/src/events/` and
`packages/core/src/events/`. The SDK owns the shared contract shape and helper
builders; the core owns the runtime stream behavior. The two surfaces are
kept intentionally aligned.

## Consequences

### Positive

- Logging and OTEL plugins get one stable subscription surface.
- Child-session and delegation visibility are explicit rather than inferred.
- The stream is replayable, which makes late subscribers and tests simpler.
- The kernel can keep its output schema decisions out of the event system.
- The implementation can be wired into the future session orchestrator without
  changing the public event vocabulary.

### Negative or to-be-paid

- The kernel now owns one more frozen lifecycle taxonomy that future work must
  respect.
- The current implementation is in-memory and self-contained; persistent event
  persistence or external fan-out remains a future plugin concern.
- The SDK and core packages each carry a mirrored implementation surface until
  the package export wiring is expanded in a later issue.

## Alternatives Considered

### Node `EventEmitter`

Rejected because it does not give us replay, sequence control, or the explicit
filtering surface we want for plugin observers.

### RxJS `Subject` / `Observable`

Rejected because it adds a heavier abstraction than the kernel needs and would
make the first implementation more complex than the event taxonomy itself.

### Private kernel callbacks only

Rejected because plugins would need bespoke hooks and the logging/OTEL surface
would become kernel-internal rather than framework-stable.

## Integration Hooks

When `KRN-04` and the eventual bootstrap path wire the orchestrator in, the
kernel should emit into this stream at the run, session, child-session, and
delegation boundaries documented in `specs/core/events/canonical-event-stream.md`.

That wiring is intentionally deferred from this scope, but the event stream
API is ready for it now.
