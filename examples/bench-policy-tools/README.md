# Bench Policy Tools

This example is the meso layer of the benchmark stack: a deterministic
policy-plus-tools adapter inspired by customer-service task suites. It is not a
fork of tau-bench; it is a small repo-local fixture that stresses the same
coordination shape: policy checks, tool sequencing, and an auditable final
decision.

## Files

- `mission.json` describes the policy-bound refund workflow.
- `benchmark.json` defines the meso benchmark and paired candidates.
- `candidates/*.json` define a direct tool executor and a policy-gated tool
  planner.
- `src/adapter.ts` runs those fixtures through `runHarnessBenchmark` with a
  deterministic in-memory runtime and renders the standard bounded report.

## Run

```bash
npm run -w @generic-ai/example-bench-policy-tools test
npm run -w @generic-ai/example-bench-policy-tools smoke
```

The smoke command prints the bounded benchmark report as Markdown.
