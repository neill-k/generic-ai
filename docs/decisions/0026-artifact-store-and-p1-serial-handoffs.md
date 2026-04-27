# 0026 - Artifact Store And P1 Serial Handoffs

## Context

The harness writes durable traces, policy decisions, handoffs, and summaries. Raw absolute paths in shared directories are not enough for a composable harness: they do not cross container boundaries cleanly and they do not carry integrity information.

Concurrent delegation also creates artifact races unless ownership, namespaces, atomic writes, and retention are defined.

## Decision

SDK artifact references use:

- `uri`
- `sha256`
- optional `localPath`
- optional `ownerId`
- optional `namespace`

The P1 local artifact store writes atomically by writing a temporary file, hashing the bytes, then renaming into place. Artifact creation emits `artifact.created` events.

P1 handoffs are explicitly serial. The root agent may delegate, but the current Pi-backed runtime waits for each delegated role before continuing. Concurrent delegation and retention policy are follow-on work.

## Consequences

Artifacts can be referenced from Harbor containers, local workspaces, and future remote stores without making absolute paths the public contract.

Serial P1 behavior avoids shared-workspace races while the harness contract settles. Future concurrent execution must extend the artifact store with stronger ownership and retention semantics before enabling parallel role writes.

## Alternatives Considered

### Keep fixed JSON filenames as the artifact contract

Rejected. Fixed paths are convenient locally, but they do not provide identity, integrity, or portability.

### Enable concurrent delegation immediately

Rejected for P1. It would force a larger coordination and artifact-retention design before the harness spine has passed smoke validation.
