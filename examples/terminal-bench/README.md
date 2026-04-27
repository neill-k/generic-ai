# Terminal-Bench Harbor Example

This private workspace is the first Generic AI integration point for Terminal-Bench through Harbor. It intentionally lives under `examples/terminal-bench/` because examples are internal, unpublished runnable references. No package in `packages/*` imports this code, and no benchmark-specific schema is promoted into a public package by this example.

## Architecture Rules

- Harbor is the orchestration authority. Use Harbor job configs and trial directories as the benchmark source of truth.
- Generic AI contracts are the report and trace authority after the run. The importer maps Harbor artifacts into the existing `TraceEvent`, `BenchmarkTrialResult`, and `BenchmarkReport` contracts from `@generic-ai/sdk`.
- Benchmark execution goes through `runAgentHarness()`, not the low-level `GenericAILlmRuntime`. The harness owns role topology, effect-based capability composition, policy decisions, canonical events, and artifact writing above Pi.
- Nested Generic AI Docker sandboxing is disabled by default. The Harbor task container is the primary runtime boundary.
- Keep Harbor-specific glue here until smoke and calibration runs prove which abstractions are reusable across more than one benchmark.

## Prerequisites

- Node 24 and npm 11 at the repo root.
- Docker available to Harbor.
- Harbor installed on the host, for example `uv tool install harbor` or `pip install harbor`.
- Generic AI runtime auth through Pi/Codex login or `GENERIC_AI_PROVIDER_API_KEY`.

Harbor currently documents `harbor run -c <job.yaml>` for config-backed jobs, custom agents through `--agent-import-path`, Terminal-Bench 2.0 through Harbor, and automatic collection of `/logs/artifacts/` into each trial's `artifacts/` directory.

## Files

- `harbor/generic_ai_agent.py`: Harbor installed-agent adapter.
- `harbor/install-generic-ai.sh.j2`: task-container install template for Node 24 and this workspace.
- `src/benchmark-agent.ts`: headless Generic AI benchmark profile invoked inside the task container.
- `src/run-terminal-bench.ts`: host-side Harbor launcher.
- `src/import-harbor-results.ts`: Harbor job importer that writes Generic AI-native reports.
- `src/render-benchmark-report.ts`: report JSON to markdown renderer.
- `configs/*.job.yaml`: smoke, quick, calibration, and full Harbor job configs.
- `skills/terminal-bench/*`: benchmark-local behavioral guidance loaded by the benchmark profile, including clean verification before finish.
- `reports/`: ignored local output area for imported Generic AI reports.

## Run Ladder

Build the workspace first:

```bash
npm run -w @generic-ai/example-terminal-bench build
```

Run the Harbor oracle before judging Generic AI wiring:

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle
```

Run one Generic AI smoke task:

```bash
npm run -w @generic-ai/example-terminal-bench terminal-bench:run -- --profile smoke
```

Run a quick multi-task smoke check before paying for repeated calibration:

```bash
npm run -w @generic-ai/example-terminal-bench terminal-bench:run -- --profile quick
```

Run the repeated calibration subset:

```bash
npm run -w @generic-ai/example-terminal-bench terminal-bench:run -- --profile calibration
```

Run the full dataset only after smoke and calibration are stable:

```bash
npm run -w @generic-ai/example-terminal-bench terminal-bench:run -- --profile full
```

The shell wrappers in `scripts/` run the same commands after building the workspace.

## Environment

- `GENERIC_AI_PROVIDER_API_KEY`: optional runtime API key.
- `GENERIC_AI_MODEL`: model id passed to Generic AI, defaulting to `gpt-5.5`.
- `GENERIC_AI_RUNTIME_ADAPTER`: `pi`/`openai-codex` both select the Pi-backed harness adapter in P1.
- `GENERIC_AI_REPO_ARCHIVE`: optional prebuilt repo archive for the Harbor adapter. If unset, the adapter creates a filtered archive from the local repo and uploads it into the task container.
- `GENERIC_AI_NODE_VERSION`: Node version installed in the task container when Node 24 is missing. Defaults to `v24.13.0`.
- `GENERIC_AI_BENCHMARK_IMMUTABLE_PATHS`: comma-separated verifier/task paths to snapshot before and after the run. Defaults to `/tests,/solution,task.toml`.

## Artifact Flow

Inside each Harbor task container, Generic AI writes:

```text
/logs/artifacts/generic-ai/
  summary.json
  trace-events.json
  trace-diagnostics.json
  policy-decisions.json
  integrity.json
  trajectory.json
  harness/
    canonical-events.json
    harness-projections.json
    policy-decisions.json
    summary.json
```

Harbor collects `/logs/artifacts/` into each trial directory. The installed agent also copies `trajectory.json` into Harbor's agent log directory when possible so Harbor can treat it as an ATIF trajectory.

After a Harbor run, import a job directory:

```bash
npm run -w @generic-ai/example-terminal-bench terminal-bench:import -- --job-dir examples/terminal-bench/jobs/<job-name>
```

The importer writes:

```text
examples/terminal-bench/reports/imported/<job-name>/
  mission.json
  benchmark.json
  trial-results.json
  benchmark-report.json
  benchmark-report.md
```

Single-task smoke reports should usually remain `insufficient_evidence`; quick runs prove several real task containers without repeated attempts, and calibration is the first rung intended to produce averages with enough evidence for stronger interpretation.

## Gates

Smoke gate means the harness launches in Harbor, the Pi-backed run completes or fails with categorized evidence, required artifacts are written, trace projections include policy/tool/handoff/artifact evidence where applicable, and at least one nonzero reward on smoke or quick is treated only as smoke evidence.

Validation gate means a pinned task set, at least five trials per configuration, flake reruns for surprising flips, and trace-completeness checks. Only validation evidence should support benchmark-quality recommendations.

## Current MVP Boundary

The current Generic AI benchmark profile proves adapter installation, headless `runAgentHarness()` invocation, starter-stack capability composition, deterministic artifact writing, integrity logging, ATIF handoff, and Harbor-result import. The verifier role may run terminal checks but does not receive direct file write/edit tools. It does not claim a leaderboard-ready Terminal-Bench agent yet, and quick-profile mean reward is not a validation gate. Further benchmark-specific promotion should wait until smoke and calibration runs show repeated reusable behavior.
