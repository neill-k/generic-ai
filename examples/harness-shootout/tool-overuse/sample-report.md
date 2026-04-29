# Benchmark Report: benchmark.tool-overuse.v0

Mission: mission.tool-overuse
Generated: 2026-04-29T00:00:00.000Z
Primary metric: task_success
Confidence: confident_recommendation
Trials: 1/1
minTrials: 1
Smoke: no

## Observations

- The disciplined candidate and tool-happy candidate both satisfy final task correctness.
- Tool-use evidence separates required, optional, and wasteful affordances.
- Optional cost and latency metadata are present for the tool-happy trace, but the evaluator can run when those fields are absent.

## Tool Use

| Candidate | Observed / Planned cases | Tool calls | Necessary | Unnecessary | Avoided | Budget violations | Direct-answer opportunities | Efficiency | Cost USD | Latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| disciplined-agent | 3/3 | 1 | 1 | 0 | 2 | 0 | 2 | 1 | 0.001 | 100 |
| tool-happy-agent | 3/3 | 4 | 1 | 3 | 0 | 1 | 2 | 0.25 | 0.006 | 600 |

## Boundary

This fixture proves report coverage for tool discipline. It does not prove a
Terminal-Bench, Harbor, or external benchmark score improvement.
