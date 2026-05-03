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
- [`dag-navigation/`](dag-navigation/): deterministic fork-merge benchmark
  profile for non-linear tool-workflow diagnostics.
- [`reliability/`](reliability/): repeated-run reliability fixture showing how
  equal average task success can hide different consistency, retry, and bounded
  failure-severity profiles.
- [`fault-injection/`](fault-injection/): deterministic boundary-fault profile
  for tool and memory degradation evidence.
- [`tool-overuse/`](tool-overuse/): deterministic tool-use discipline fixture
  that separates final correctness from unnecessary calls, avoided calls,
  direct-answer opportunities, and budget violations.
- [`contextual-integrity/`](contextual-integrity/): deterministic workspace
  privacy fixture that separates task utility from prohibited data-class
  disclosures under recipient/purpose transmission principles.
- [`chinese-web-research/`](chinese-web-research/): deterministic multilingual
  web-research fixture that separates answer correctness from source
  provenance, cross-source reconciliation, stale-source use, and Chinese text
  preservation.
- [`single-agent-baseline/`](single-agent-baseline/): deterministic comparator
  fixture showing multi-agent wins, single-agent wins, and underpowered
  baseline outcomes under the same mission.

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
- Separate benchmark profiles can use the same report contracts for native
  Generic AI failure modes such as DAG navigation.
- Repeated-run reports can expose pass rate, pass@k, consistency, variance,
  retries, skipped/excluded trials, perturbation labels, and failure severity
  without hiding failed attempts.
- Fault-injection profiles can represent boundary degradation, containment,
  first violated contracts, and overclaim-prevention evidence without making
  core import plugin-specific injectors.
- Tool-overuse profiles can record required, optional, and wasteful tool
  affordances so reports can show tool efficiency separately from final answer
  correctness and optional cost/latency metadata.
- Contextual-integrity profiles can model actors, data classes, transmission
  principles, and privacy-flow cases so reports expose utility, leakage,
  required disclosure misses, and prohibited disclosure violations separately.
- Web-research profiles can preserve Chinese source titles/snippets, citation
  requirements, reconciliation evidence, stale-source warnings, and
  provider-gated live-search expectations without binding reports to one search
  vendor.
- Single-agent baseline comparators can prevent multi-agent recommendations
  unless same-mission evidence clears the configured primary-metric delta.

## What It Does Not Prove Yet

- Hosted registry or marketplace behavior.
- Autonomous self-mutation.
- Statistical confidence beyond the configured trial population.
- A full workflow engine independent of the protocol ABI.
- External benchmark score movement from evidence-surface fixtures alone.
