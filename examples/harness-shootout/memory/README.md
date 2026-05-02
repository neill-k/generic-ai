# Memory Benchmark Profile

This profile is a deterministic evidence-surface fixture, not an external
MemoryAgentBench, LongMemEval, LoCoMo, or MemBench score claim.

## Planned Cases

- `retrieve-grounded-preferences`: relevant memory retrieval and grounding.
- `apply-preference-update`: current preference supersedes stale preference.
- `suppress-stale-vendor-status`: stale fact is detected and withheld.
- `honor-selective-forgetting`: tombstoned personal detail does not reappear.
- `explain-memory-provenance`: answer cites message/run provenance.
- `preserve-multi-session-handoff`: later session preserves prior-session state.

## Evidence Boundary

The benchmark report records answer correctness separately from memory-operation
quality. Memory summaries include retrieval misses, stale fact use, stale
suppression, forgotten-reference leaks, provenance coverage, handoff preservation,
latency, token count, and warnings.

Use this profile to validate Generic AI memory evidence contracts and local
plugin behavior. A future adapter can map the same fields to external memory
benchmarks before making score-movement claims.
