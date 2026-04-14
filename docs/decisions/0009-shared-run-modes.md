# 0009. Shared run modes and pluggable async scheduling

## Context

`KRN-06` needs both synchronous in-process execution and asynchronous queued execution, but the architecture pack is explicit that both execution styles must share the same session machinery. The queue plugin owns scheduling behavior, while the kernel owns session creation, observation, and completion tracking.

At the same time, the session and event modules are still being finalized in parallel. The run-mode implementation therefore needs a narrow local port that can stand in for the eventual kernel session/event symbols without forcing a premature public API shape.

## Decision

The core package now exposes a local run-mode layer built on a shared session machine:

- a single session factory creates root sessions and child sessions with the same lifecycle semantics
- session events bubble from child to parent observers
- sync execution runs inline against the shared session machine
- async execution schedules the same session lifecycle through an injected scheduler interface
- the scheduler is not hardcoded in the kernel and can be swapped by the queue plugin later

The implementation also includes a small set of scheduler helpers:

- an immediate scheduler for inline behavior
- a manual scheduler for tests and deterministic async flushing
- a microtask scheduler for lightweight local async execution

## Consequences

- sync and async execution remain behaviorally aligned because they share the same session model
- async scheduling stays replaceable, which keeps the queue plugin boundary clean
- child session visibility is testable now instead of being implicit inside a later kernel rewrite
- the implementation is intentionally narrow and does not define the final public kernel envelope

## Alternatives Considered

### Hardcode async scheduling in the kernel

Rejected because it would make the queue plugin impossible to replace cleanly later and would bake a scheduling policy into the wrong layer.

### Split sync and async into separate session systems

Rejected because it would duplicate lifecycle logic and make child-session observability drift between execution modes.

### Wait for the session/event modules to land first

Rejected because `KRN-06` needs a concrete behavior target now, and the local port lets the parallel work converge without blocking this scope.

