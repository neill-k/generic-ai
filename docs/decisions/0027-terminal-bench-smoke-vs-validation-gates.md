# 0027 - Terminal-Bench Smoke Versus Validation Gates

## Context

A quick Terminal-Bench run with a small task count and one attempt can prove wiring, but it cannot validate agent quality. Treating "mean reward above zero" on a quick profile as a P1 validation gate would overstate the evidence.

The existing benchmark/report contracts already distinguish smoke evidence from recommendation-quality evidence through trial counts and trace-completeness requirements.

## Decision

Terminal-Bench gates are split into two levels.

Smoke gate:

- Harbor launches Generic AI.
- The Pi-backed harness runs inside the task container.
- Required artifacts are produced.
- Trace projections include tool, policy, handoff, and artifact evidence where applicable.
- At least one nonzero reward on the quick/smoke profile is useful evidence, but it is labeled smoke.

Validation gate:

- pinned task set.
- at least five trials per configuration.
- flake reruns for surprising pass/fail flips.
- trace-completeness check.
- report wording may make recommendations only when the benchmark spec meets its minimum-trial and evidence requirements.

## Consequences

P1 can still require a live smoke proof before merge without pretending the agent is benchmark-validated.

Terminal-Bench calibration and full runs remain manual gates because they are expensive and environment-sensitive. They are required before claiming benchmark quality or architectural recommendations.

## Alternatives Considered

### Keep "quick mean reward > 0" as the P1 gate

Rejected. It can be satisfied by a lucky partial result and does not match the report layer's own evidence threshold.

### Require full validation before landing the harness spine

Rejected. That would block contract and runtime work on benchmark variance. The right order is contract correctness, smoke proof, then validation.
