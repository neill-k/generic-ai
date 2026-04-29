# 0034. Reversibility Effect Descriptors

## Status

Accepted.

## Context

ADR 0024 requires plugins to declare authority effects before harness roles can
use their tools. That made "what can this tool do?" explicit, but it does not
yet answer "how expensive is it to recover if this action is wrong?"

The research-harness direction needs both dimensions. A final answer can be
correct while hiding risky irreversible steps, and a failed run can still be
valuable evidence if it recovered cleanly. Evaluators need structured metadata
for graceful failure, rollback, retry, and supersession instead of inferring
those properties from prose.

## Decision

Generic AI will treat reversibility as a first-class effect descriptor dimension
alongside authority.

The initial levels are:

- `irreversible` - the action cannot be undone by the harness with available
  state. This is the safe default for missing metadata.
- `reversible-with-cost` - recovery is possible but consumes meaningful time,
  budget, external quota, human review, or cleanup work.
- `reversible-cheap` - recovery is available through a bounded local undo,
  superseding write, replay, cache invalidation, or retry.

Effect events and policy evidence may also describe:

- `supersedes` - the current effect replaces or invalidates an earlier effect
  record.
- `retryOf` - the current effect is a retry attempt for an earlier failed or
  uncertain effect.
- `recoveryAction` - the current effect is intentionally repairing, rolling
  back, or compensating for an earlier effect.

Capability authors must not claim cheap reversibility unless the implementation
actually has the state, operation, or compensation path needed to perform it.
When in doubt, descriptors stay `irreversible`.

The SDK schema and plugin backfill land in the W3 implementation workstream.
This ADR defines the semantics and default posture; it does not require Worker D
to edit SDK harness types or plugin descriptors in this change.

## Consequences

- Reports can score recovery quality and failure containment, not just final
  success.
- Role policies can later grant high-authority effects differently when the
  recovery posture is cheap, costly, or absent.
- Existing tools without reversibility metadata remain conservative because
  missing metadata means `irreversible`.
- Supersession and retry references become evidence handles that report
  renderers and provenance bundles can cite.

## Alternatives Considered

### Model reversibility only as policy text

Rejected. Policy text helps humans, but benchmark reports and harness evaluators
need a structured field to compare recovery behavior across plugins.

### Infer reversibility from effect names

Rejected. `fs.write`, `memory.write`, and `artifact.write` can each be cheap,
costly, or irreversible depending on implementation and storage posture.

### Default missing reversibility to cheap

Rejected. That would hide the riskiest case. The harness should fail closed and
force capability authors to earn weaker claims.
