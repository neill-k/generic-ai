# Benchmark Report: benchmark.dag-navigation.v0

Mission: mission.dag-navigation

## Observations

- The profile measures DAG traversal separately from final answer correctness.
- Wrong-branch selection can have high tool correctness while navigation and
  branch coverage are low.
- Bad tool output can have complete navigation while tool correctness and
  aggregation correctness fail.

## Inferences

- A linear tool-chain baseline may reach the merge step too early even when the
  branch tool it did call returned correct output.
- A DAG-aware or branch-worker harness should be judged on branch coverage,
  graph-order evidence, and aggregation correctness before any recommendation.

## Recommendations

- Treat this fixture as coverage for non-linear workflow failure modes until
  same-profile trials are collected.
- Keep `insufficient_evidence` when trace completeness or the configured trial
  count is below the benchmark threshold.
- Do not compare this score directly to Terminal-Bench reward or success; it
  measures a native Generic AI graph-navigation profile.

## Failure Examples

| Failure | Navigation progress | Branch coverage | Tool correctness | Diagnosis |
| --- | ---: | ---: | ---: | --- |
| Wrong branch selection | 0.5 | 0.5 | 1.0 | Missing beta branch before merge |
| Bad tool output | 1.0 | 1.0 | 0.5 | Beta branch oracle mismatch |

## Evidence Boundary

This report shape is an evidence-surface and coverage improvement. A future
adapter may map external DAG-navigation benchmarks into the same metrics, but
this fixture alone does not establish external SOTA movement.
