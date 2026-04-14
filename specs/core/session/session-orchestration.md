# Session Orchestration

## Goal

The kernel owns one shared session tree model for both root runs and delegated child runs.

## Model

- A root session starts a tree.
- Child sessions always point to a direct parent and the owning root session.
- Sessions are independently addressable by id.
- Parent sessions can observe child sessions through the tree snapshot.

## Lifecycle

- `createRootSession()` creates an active root session.
- `createChildSession(parentSessionId)` creates an active child session under an active parent.
- `completeSession(sessionId)` marks a session succeeded once its descendant subtree is already terminal.
- `failSession(sessionId)` marks a session failed and cancels active descendants.
- `cancelSession(sessionId)` marks a session cancelled and cancels active descendants.

## Terminal Collection

- Every terminal session exposes a terminal state snapshot.
- `collectTerminalStates(sessionId)` returns terminal states for the requested session and all descendants.
- Parent snapshots surface the same terminal-state collection for observability.

## Invariants

- A child session cannot be created under a terminal parent.
- Success requires the subtree below a session to be terminal first.
- Failure and cancellation cascade only to active descendants.
- Root and child sessions remain observable independently.

