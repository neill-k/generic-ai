# Benchmark Report: benchmark.repeated-run-reliability.v0

Mission: mission.oauth-login

Primary metric: task_success

## Observations

- Both candidates average `task_success = 0.5`.
- `pipeline-bursty` passes two early trials, fails two later trials, includes one retry, and reaches critical bounded failure severity.
- `verifier-loop-steady` passes all four scored trials at the configured `task_success >= 0.5` threshold and keeps bounded failure severity low.

## Reliability

| Candidate | Passed / Scored | Pass rate | Consistency | Variance | Max failure severity | Retries |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| pipeline-bursty | 2/4 | 0.5 | 0.5 | 0.25 | critical | 1 |
| verifier-loop-steady | 4/4 | 1 | 1 | 0 | low | 0 |

## Interpretation

This fixture is intentionally not a SOTA score claim. It shows why repeated-run
reliability belongs beside average score: two harnesses can tie on the primary
metric while differing on consistency, retry accounting, and bounded failure
severity.
