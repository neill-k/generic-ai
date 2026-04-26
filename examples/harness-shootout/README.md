# Harness Shootout Example

This example is the v0.1 public launch fixture for Generic AI as an
agents-as-code language and evidence harness.

It declares one coding mission once, then runs the same MissionSpec through four
package-composed candidate harnesses:

- Pipeline
- Verifier Loop
- Hierarchy
- Squad

The benchmark runner compiles each Harness DSL file into Generic Agent IR before
runtime execution. Runtime inference uses `GenericAILlmRuntime`, whose default
`openai-codex` adapter uses Pi's `openai-codex` provider path.

## Files

- [`mission.json`](mission.json): controlled coding mission.
- [`benchmark.json`](benchmark.json): candidate/trial/validity/report plan.
- [`candidates/pipeline.json`](candidates/pipeline.json): fixed-stage pipeline.
- [`candidates/verifier-loop.json`](candidates/verifier-loop.json): solver,
  critic, repairer, and gate loop.
- [`candidates/hierarchy.json`](candidates/hierarchy.json): manager and worker
  decomposition.
- [`candidates/squad.json`](candidates/squad.json): shared-space squad
  coordination.
- [`sample-report.md`](sample-report.md): example of bounded interpretation.

## Programmatic Shape

```ts
import { runHarnessBenchmark } from "@generic-ai/core";

await runHarnessBenchmark({
  benchmark,
  mission,
  harnesses,
  runtimeOptions: {
    adapter: "openai-codex",
    model: "gpt-5.5",
    agentDir: ".pi/agent",
  },
});
```

Use `GENERIC_AI_PROVIDER_API_KEY` only when you want to inject a runtime key.
Otherwise, log in with Pi so the agent directory contains OpenAI Codex auth.

## What The Fixture Proves

- The same mission can be declared independently from coordination architecture.
- Candidate harnesses compile into the same runtime contract shape.
- Reports distinguish facts, inferences, and recommendations.
- Underpowered runs produce `insufficient_evidence`.

## What It Does Not Prove Yet

- Hosted registry or marketplace behavior.
- Autonomous self-mutation.
- Statistical confidence beyond the configured trial population.
- A full workflow engine independent of the protocol ABI.
