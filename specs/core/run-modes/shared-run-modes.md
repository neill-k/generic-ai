# Shared Run Modes

This spec captures the shared session machinery for `KRN-06`.

## Goals

- sync and async execution use the same session model
- child sessions remain observable from their parent and independently from their own observers
- async scheduling stays injected, so the kernel does not hardcode a queue or microtask strategy

## Session Model

- `createRunSessionMachine()` creates root sessions.
- each session can create child sessions with the same lifecycle semantics.
- session events bubble to parent observers without removing the child's own local observers.
- lifecycle events are emitted for `session-created`, `session-started`, `session-child-created`, `session-succeeded`, `session-failed`, and `session-cancelled`.

## Run Modes

- `createSyncRunMode()` executes work immediately and returns the task result directly.
- `createAsyncRunMode({ scheduler })` schedules work through the injected scheduler and resolves a promise when the task completes.
- both modes use the same session factory and the same lifecycle transitions.

## Scheduler Contract

- `createImmediateScheduler()` is a local helper for inline execution.
- `createManualScheduler()` is a test helper and a demonstration of pluggable queue behavior.
- `createMicrotaskScheduler()` is a lightweight async option for local runtimes.

## Upstream Symbols Expected Later

The session and event modules are still moving in parallel. This scope intentionally stays narrow and expects the eventual kernel layer to provide the final public exports for:

- canonical kernel session creation
- canonical event taxonomy
- run envelope assembly

This implementation keeps those boundaries local so the main agent can wire the eventual kernel contracts without changing the run-mode behavior.

