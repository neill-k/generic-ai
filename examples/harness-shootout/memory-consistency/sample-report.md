# Benchmark Report: benchmark.memory-consistency.v0

Mission: mission.memory-consistency
Generated: 2026-05-03T00:00:00.000Z
Primary metric: memory_consistency_score
Confidence: confident_recommendation
Trials: 1/1
minTrials: 1
Smoke: no

## Observations

- Collected 0 trace events across 2 trial runs.
- Memory-consistency profile summarized 4/4 planned multi-agent memory case(s).

## Inferences

- Trial evidence is sufficient for a confident recommendation under the configured threshold.
- Memory-consistency evidence is reported separately from final task correctness.
- eventual-memory-team: 1 stale memory read(s) recorded.
- eventual-memory-team: 1 unresolved memory conflict(s) recorded.
- eventual-memory-team: 1 memory handoff drift(s) recorded.
- eventual-memory-team: 1 duplicate memory projection(s) recorded.
- eventual-memory-team: 2 memory provenance gap(s) recorded.

## Recommendations

- consistency-aware-team: recommended; memory_consistency_score=1, stale_reads=0, unresolved_conflicts=0, handoff_drifts=0, provenance_gaps=0
- eventual-memory-team: not_recommended; memory_consistency_score=0.25, stale_reads=1, unresolved_conflicts=1, handoff_drifts=1, provenance_gaps=2

## Candidates

| Candidate | Harness | Trials | pass^k | Reversibility | Trace completeness | Confidence | Recommendation |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
| consistency-aware-team | harness.memory-consistency.consistency-aware-team:compiled | 1 | pass^1=1 | not recorded | 1 | confident_recommendation | recommended |
| eventual-memory-team | harness.memory-consistency.eventual-memory-team:compiled | 1 | pass^1=0 | not recorded | 1 | confident_recommendation | not_recommended |

## Memory Consistency

| Candidate | Observed / Planned cases | Consistency score | Stale reads | Conflicts | Unresolved conflicts | Handoff drifts | Duplicate projections | ACL violations | Provenance gaps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| consistency-aware-team | 4/4 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| eventual-memory-team | 4/4 | 0.25 | 1 | 1 | 1 | 1 | 1 | 0 | 2 |

### Memory Consistency Warnings

- eventual-memory-team: 1 stale memory read(s) recorded.
- eventual-memory-team: 1 unresolved memory conflict(s) recorded.
- eventual-memory-team: 1 memory handoff drift(s) recorded.
- eventual-memory-team: 1 duplicate memory projection(s) recorded.
- eventual-memory-team: 2 memory provenance gap(s) recorded.

