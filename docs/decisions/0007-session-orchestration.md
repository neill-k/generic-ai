# 0007: Session Orchestration

## Status

Accepted

## Context

The kernel needs one orchestration model for synchronous runs, queued runs, delegation, and future session-aware plugins. The model has to support root sessions, child sessions, independent observability, and terminal-state collection without forcing business logic into the kernel.

## Decision

The kernel will own a single in-memory session tree model with these rules:

- root sessions start trees
- child sessions always link to a direct parent and the owning root
- sessions remain independently queryable
- parent snapshots expose their child sessions
- terminal states are derived from the tree and collected at the root
- success requires a terminal descendant subtree
- failure and cancellation cascade to active descendants only

## Consequences

- sync and queued execution can share the same session machinery
- delegation plugins can rely on child sessions without owning lifecycle rules
- observability plugins can inspect terminal states without private kernel hooks
- the kernel stays narrow because it only owns orchestration, not output shaping or business semantics

## Notes

This decision intentionally keeps the session model local to `@generic-ai/core` and avoids requiring broader plugin-host or event-stream changes in the same pass.

