# Benchmark Report: benchmark.package-composed-shootout.v0

Mission: mission.oauth-login
Primary metric: task_success
Confidence: insufficient_evidence
Trials: 0/5
minTrials: 5
Smoke: no

## Observations

- Each candidate compiled into Generic Agent IR before runtime execution.
- Trial evidence includes trace events, assistant-output artifacts, metric values, and compiled harness fingerprints.
- The configured validity gate requires five paired trials, pass^5 reliability, and complete traces.

## Inferences

- Pipeline is the simplest coordination baseline.
- Verifier Loop may improve review coverage at the cost of rework and latency.
- Hierarchy can make authority and escalation explicit, but it depends on policy checks being complete.
- Squad can reduce central bottlenecks, but duplicate-work and claim semantics must be visible in traces.
- No candidate has enough observed trials in this static sample to support a confident recommendation.

## Recommendations

- Treat the sample as a wiring and interpretation guide until real trial outputs are collected.
- Do not declare a winner from a single smoke run.
- Prefer `insufficient_evidence` when trace completeness, policy decisions, or trial population are below the BenchmarkSpec threshold.

## Candidate Reliability

| Candidate | Harness | Trials | pass^k | Reversibility | Confidence | Recommendation |
| --- | --- | ---: | ---: | --- | --- | --- |
| pipeline | harness.pipeline | 0/5 | missing | not recorded | insufficient_evidence | insufficient_evidence |
| verifier-loop | harness.verifier-loop | 0/5 | missing | not recorded | insufficient_evidence | insufficient_evidence |
| hierarchy | harness.hierarchy | 0/5 | missing | not recorded | insufficient_evidence | insufficient_evidence |
| squad | harness.squad | 0/5 | missing | not recorded | insufficient_evidence | insufficient_evidence |

## Confidence Boundary

- `minTrials` is 5, so fewer than five observed trials per candidate yields `insufficient_evidence`.
- `pass^5` is reported only after primary-metric samples exist; it is not inferred from fixture intent.
- Reversibility is reported only from trace events that declare the effect
  dimension; missing metadata is not treated as cheap recovery.

## Evidence Boundary

The report keeps facts, inferences, and recommendations separate. Every
load-bearing claim should link to a metric, trace event, artifact, or compiled
fingerprint in generated reports.
