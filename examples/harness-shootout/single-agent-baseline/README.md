# Single-Agent Baseline Comparator

This deterministic fixture keeps multi-agent recommendations honest. It marks
`single-agent-baseline` as the benchmark's same-mission baseline and requires
non-baseline candidates to clear a normalized `task_success` delta of `0.05`
before reports can recommend the extra coordination structure.

The fixture includes three evidence shapes:

- `trial-results-multi-agent-win.json`: the verifier loop beats the baseline by
  enough to be recommended.
- `trial-results-single-agent-win.json`: the verifier loop is slightly higher
  on task success, but not enough to clear the baseline delta, so the
  single-agent baseline remains recommended.
- `trial-results-baseline-underpowered.json`: the multi-agent candidate has
  three trials, but the baseline has only one under a three-trial floor, so the
  report stays `insufficient_evidence`.

This is an evidence-surface fixture. It does not claim external benchmark score
movement.
