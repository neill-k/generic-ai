# Bench Tool Calling

This example is the micro layer of the benchmark stack: a deterministic
function-calling and retrieval adapter that uses the same
`BenchmarkSpec` -> `MissionSpec` -> report pipeline as `examples/harness-shootout`.

The fixture asks candidates to answer a small benefits-policy question by
calling a lookup-style tool and citing the matching retrieval chunk. It is
BFCL-style in spirit, but intentionally tiny and repo-local.

## Files

- `mission.json` describes the stable retrieval/function-calling task.
- `benchmark.json` defines the benchmark, metrics, trials, and candidate refs.
- `candidates/*.json` define two sample harness candidates.
- `src/adapter.ts` loads the fixtures and runs `runHarnessBenchmark` with a
  deterministic in-memory runtime.

## Run

```bash
npm run -w @generic-ai/example-bench-tool-calling test
npm run -w @generic-ai/example-bench-tool-calling smoke
```

The smoke command prints the bounded benchmark report as Markdown.
