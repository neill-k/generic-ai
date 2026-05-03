# Single-Agent Baseline Comparator Sample

Benchmark: `benchmark.single-agent-baseline.v0`

Primary metric: `task_success`

Required normalized delta: `0.05`

## Multi-Agent Win

| Candidate | Baseline outcome | Task success | Delta | Recommendation |
| --- | --- | ---: | ---: | --- |
| single-agent-baseline | baseline | 0.8 | 0 | not_recommended |
| verifier-loop | beats_baseline | 0.9 | 0.1 | recommended |
| hierarchy | within_threshold | 0.82 | 0.02 | not_recommended |

The verifier loop is recommended only because it clears the configured
same-mission baseline delta. Cost, wall time, handoffs, and trace completeness
remain visible as guardrail deltas.

## Single-Agent Win

| Candidate | Baseline outcome | Task success | Delta | Recommendation |
| --- | --- | ---: | ---: | --- |
| single-agent-baseline | baseline | 0.9 | 0 | recommended |
| verifier-loop | within_threshold | 0.92 | 0.02 | not_recommended |

The verifier loop is slightly higher on the primary metric, but the improvement
does not clear the threshold. The report keeps the simpler baseline
recommended.

## Insufficient Evidence

| Candidate | Trials | Baseline outcome | Recommendation |
| --- | ---: | --- | --- |
| single-agent-baseline | 1/3 | baseline | insufficient_evidence |
| verifier-loop | 3/3 | insufficient_evidence | insufficient_evidence |

The multi-agent candidate cannot be recommended when the declared baseline is
underpowered, even if the multi-agent candidate has enough trials on its own.
