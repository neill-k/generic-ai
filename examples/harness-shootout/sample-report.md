# Benchmark Report: benchmark.package-composed-shootout.v0

Mission: mission.oauth-login

## Observations

- Each candidate compiled into Generic Agent IR before runtime execution.
- Trial evidence includes trace events, assistant-output artifacts, metric values, and compiled harness fingerprints.
- The configured validity gate requires three paired trials and complete traces.

## Inferences

- Pipeline is the simplest coordination baseline.
- Verifier Loop may improve review coverage at the cost of rework and latency.
- Hierarchy can make authority and escalation explicit, but it depends on policy checks being complete.
- Squad can reduce central bottlenecks, but duplicate-work and claim semantics must be visible in traces.

## Recommendations

- Treat the sample as a wiring and interpretation guide until real trial outputs are collected.
- Do not declare a winner from a single smoke run.
- Prefer `insufficient_evidence` when trace completeness, policy decisions, or trial population are below the BenchmarkSpec threshold.

## Evidence Boundary

The report keeps facts, inferences, and recommendations separate. Every
load-bearing claim should link to a metric, trace event, artifact, or compiled
fingerprint in generated reports.
