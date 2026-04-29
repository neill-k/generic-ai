# 0025 - Canonical Harness Event Schema v0.1

## Context

Terminal-Bench reports and ATIF trajectories need real tool/action evidence. Inferring canonical event meaning from plugin event-name substrings is fragile: renaming a plugin event should not silently change report semantics.

## Decision

Generic AI defines an explicit v0.1 harness event projection schema.

The initial event type set includes:

- `run.started`, `run.completed`, `run.failed`
- `session.started`, `session.completed`, `session.failed`
- `tool.call.started`, `tool.call.completed`, `tool.call.failed`
- `terminal.command.started`, `terminal.command.completed`, `terminal.command.failed`
- `policy.decision`
- `artifact.created`
- `handoff.requested`, `handoff.accepted`, `handoff.completed`, `handoff.failed`
- `model.message`

Core maps Pi session events by structured event payload fields such as `type`, `toolName`, and `isError`, not by substring matching the emitted plugin event name.

Effect-bearing events may include `reversibility` and `supersedesEventId`.
Reports treat those fields as optional evidence metadata: when they are present,
they can support rollback/recovery analysis; when they are absent, the report
must not infer cheap reversibility.

## Consequences

ATIF and Generic AI benchmark reports can depend on stable event semantics.

P1 still forwards raw Pi/plugin events for debugging, but evidence-producing importers should use the typed harness event projections.

## Alternatives Considered

### Use raw plugin event names as the report contract

Rejected. Raw event names are useful diagnostics, but they are not a stable evidence schema.

### Wait for a complete event ontology

Rejected. P1 needs a small, explicit v0.1 schema now so Terminal-Bench artifacts are not decorative.
