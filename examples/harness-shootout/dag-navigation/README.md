# DAG Navigation Benchmark Profile

This profile covers fork-merge tool workflows where the agent must navigate a
task graph, collect branch facts, clear a roadblock, and aggregate the result.
It complements the package-composed shootout by exercising graph traversal
failure modes instead of another linear coding task.

The first fixture is deterministic and local-only. It does not claim external
benchmark score movement; it is benchmark coverage and evidence infrastructure
for comparing candidate harnesses under the same graph.

## Files

- [`mission.json`](mission.json): fork-merge DAG mission.
- [`benchmark.json`](benchmark.json): metrics and validity rules.
- [`candidates/linear-chain.json`](candidates/linear-chain.json): a linear
  baseline that is expected to miss branch coverage.
- [`candidates/dag-aware-planner.json`](candidates/dag-aware-planner.json): a
  planner/verifier candidate intended to preserve graph state.
- [`candidates/squad-branch-workers.json`](candidates/squad-branch-workers.json):
  a branch-worker candidate intended to parallelize branch collection.
- [`failure-examples.json`](failure-examples.json): synthetic failure traces that
  distinguish wrong branch selection from bad tool output.
- [`sample-report.md`](sample-report.md): bounded interpretation example.

## Metrics

- `final_success`: end-to-end DAG answer correctness.
- `navigation_progress`: required graph nodes visited in order.
- `branch_visit_completeness`: branch coverage before merge.
- `tool_correctness`: branch tool outputs match the fixture oracle.
- `aggregation_correctness`: merge answer uses every required branch fact.
- `trace_completeness`: trace events are complete enough to diagnose failures.

## Evidence Boundary

Keep score claims bounded to same-profile runs. A report may say this profile
improves benchmark coverage when the fixture compiles and emits these metrics.
It must not claim SOTA or Terminal-Bench performance movement without an
external benchmark adapter and comparable before/after results.
