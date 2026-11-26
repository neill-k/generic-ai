# 0058. Goal Evals From Traces

## Context

Goals and validators (0050) let an agent keep working until its definition
of done is met. They do not say how often an agent gets there, how much it
spends doing so, or whether it got there honestly. The reliability gate for
production needs those numbers, and the NOVA design brief asks for evals that
show where to add complexity instead of adding it up front.

Two problems in the existing benchmark layer stood in the way. The harness
benchmark sent one prompt to one model per trial even for candidates that
declare a topology, so it never measured the multi-agent system it named.
And the benchmark report's `pass^k` was computed as `1 - (1 - p)^k`, which is
pass@k: it rises with `k` and reported 0.92 for a candidate that passed two
of five trials.

## Decision

- Add an SDK goal-eval module (`packages/sdk/src/evals/`, documented in
  `docs/goal-evals.md`): suites of goal cases, a scorer that re-runs a case's
  validators on one attempt's output and canonical events, a summary with
  pass rate, pass^k, per-check scores for NOVA's three checks (numeric,
  rubric, required actions), tokens and dollars per completed goal, ranked
  findings, and a gate verdict, plus a markdown renderer.
- Score from traces only. An attempt is a record of output plus canonical
  events, so the same scorer works live, through an executor, or after the
  fact from the durable run store.
- Never trust an in-run verdict. The eval re-validates, adds held-out
  validators the agent never sees, and records integrity findings for writes
  to protected paths, any access to hidden paths, goal fingerprint
  mismatches, and COMPLETE claims it cannot reproduce. Any finding fails the
  attempt; the default gate allows none.
- Run topologies for real. `createTopologyGoalEvalExecutor` runs each attempt
  through `runHarnessTopology`, and `runHarnessBenchmark` does the same for
  candidates with a protocol binding when given `createActorRunner`.
  `MissionSpec.goal` makes benchmark `task_success` mean "goal COMPLETE".
- Fix `pass^k` to mean "k attempts in a row all pass", estimated as
  `C(c, k) / C(n, k)` with `p^k` as the fallback, shared by benchmark reports
  and goal evals.

## Consequences

- The reliability gate can run a suite per company template and fail on
  pass^k, tokens per completed goal, cost, or any integrity finding.
- Benchmark reports with repeated trials now show lower, honest pass^k values.
  Single-trial reports are unchanged, since both formulas agree at `k = 1`.
- Attempts without usage evidence are counted separately, so a runtime that
  is not metered cannot make tokens per goal look better.
- Integrity checks are trace heuristics. They complement, and do not replace,
  keeping answer keys and validators outside the agent's workspace.

## Alternatives Considered

- Extend `BenchmarkSpec` instead of adding suites. Rejected: benchmarks
  compare candidate harnesses on one mission; evals track many goals over
  time for one harness. They share the estimator and the goal contract.
- Trust in-run validation reports. Rejected: the agent's run produces them,
  which is the thing being measured.
- Use an LLM judge for every case. Rejected: NOVA puts numeric checks and
  required actions first because they are cheap and exact; rubric judges are
  one validator kind among several.
