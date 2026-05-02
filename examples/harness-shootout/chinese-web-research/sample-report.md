# Benchmark Report: benchmark.chinese-web-research.v0

Mission: mission.chinese-web-research
Generated: 2026-05-02T00:00:00.000Z
Primary metric: answer_correctness
Confidence: confident_recommendation
Trials: 1/1
minTrials: 1
Smoke: no

## Observations

- Collected 0 trace events across 2 trial runs.
- Web-research profile summarized 2/2 planned source-reconciliation case(s).

## Inferences

- Trial evidence is sufficient for a confident recommendation under the configured threshold.
- Web-research source evidence is reported separately from final answer correctness.
- citation-naive-researcher: 1 stale-source use(s) recorded.
- citation-naive-researcher: At least one web-research observation reported corrupted Chinese text.

## Recommendations

- source-aware-researcher: recommended; web_research_answer_correct=1, citation_coverage=1, reconciliation_rate=1, stale_source_uses=0
- citation-naive-researcher: not_recommended; web_research_answer_correct=0.5, citation_coverage=0, reconciliation_rate=0, stale_source_uses=1

## Candidates

| Candidate | Harness | Trials | pass^k | Reversibility | Trace completeness | Confidence | Recommendation |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
| source-aware-researcher | harness.chinese-web-research.source-aware-researcher:compiled | 1 | pass^1=1 | not recorded | 1 | confident_recommendation | recommended |
| citation-naive-researcher | harness.chinese-web-research.citation-naive-researcher:compiled | 1 | pass^1=0.5 | not recorded | 1 | confident_recommendation | not_recommended |

## Web Research

| Candidate | Observed / Planned cases | Answer correctness | Citation coverage | Reconciliation | Stale source uses | Chinese text preserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| source-aware-researcher | 2/2 | 1 | 1 | 1 | 0 | 1 |
| citation-naive-researcher | 2/2 | 0.5 | 0 | 0 | 1 | 0.5 |

### Web Research Warnings

- citation-naive-researcher: 1 stale-source use(s) recorded.
- citation-naive-researcher: At least one web-research observation reported corrupted Chinese text.
