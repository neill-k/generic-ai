# Memory Consistency Fixture

This deterministic fixture covers multi-agent memory consistency as an evidence
surface separate from single-agent retrieval quality.

The profile focuses on shared-team memory behavior that can break benchmark
interpretation even when final task success is high:

- conflicting writes that need explicit resolution,
- stale reads across child-agent handoffs,
- idempotent message-to-memory projection,
- namespace ACL denial,
- provenance completeness for replayable claims.

The fixture is evidence infrastructure. It does not claim an external memory
benchmark score improvement, and it does not upgrade the file-backed memory
plugin into a distributed consistency system.

