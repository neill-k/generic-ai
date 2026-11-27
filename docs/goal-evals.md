# Goal Evals

A goal eval answers one question: does the agent actually reach its goals,
how reliably, and at what cost? It replays goals, scores each attempt from
its trace, and rolls the scores into a report whose gate the reliability gate
reads. The code lives in `@generic-ai/sdk` (`packages/sdk/src/evals/`).

Goal evals build on [goals and validators](goals.md). A goal says what "done"
means; an eval measures how often the agent gets there.

## What is measured

The NOVA paper's goal section names three kinds of measurable outcome. Each
maps to a validator kind, and the report scores each one separately:

| NOVA check | Validator kind | Report label |
| --- | --- | --- |
| Outcomes measured as a number | `numeric` | Numeric outcomes |
| Subjective outcomes graded with a rubric | `rubric` | Rubric grades |
| Did the agent take the correct actions (needs the trace) | `trace` | Required actions |

`output_schema` and `check` validators are scored too, as "Output structure"
and "Host checks".

Per attempt, the eval also records tokens and dollars (from `usage.recorded`
events), wall time, and integrity findings. Per case and per suite it reports:

- **Pass rate**: attempts that reached the goal.
- **pass^k**: the probability that `k` attempts in a row all pass. With
  `n >= k` attempts and `c` passes it is `C(c, k) / C(n, k)`; with fewer it is
  `p^k`. A production agent has to be right every time it runs, so this is the
  reliability figure, not pass@k.
- **Tokens and dollars per completed goal**: every token spent, including on
  failed attempts, divided by attempts that passed. This is the figure NOVA's
  90% token cut is measured against. Attempts with no usage evidence are
  counted separately and never treated as free.
- **Findings**: the checks that failed most often, with the message the agent
  saw. NOVA says to start simple and add complexity where evals show
  problems; findings are where to look first when changing prompts, tools,
  validators, or harvested scripts.

An attempt passes only when its run finished, every visible required
validator passed, every held-out validator passed, and there is no integrity
violation.

## Suites

```ts
import { runGoalEvalSuite, renderGoalEvalMarkdown } from "@generic-ai/sdk";

const report = await runGoalEvalSuite({
  suite: {
    kind: "generic-ai.goal-eval-suite",
    id: "research-template",
    cases: [
      {
        id: "nvda-rating",
        goal: nvdaGoal, // a GoalSpec, see docs/goals.md
        instruction: "Use the research CLI to gather data first.",
        holdoutValidators: [
          { id: "not-flat", kind: "numeric", source: { outputPath: "rating" }, operator: "neq", value: 5 },
        ],
        hiddenPaths: ["answers/"],
      },
    ],
    trials: { count: 5 },
    gate: { minPassK: 0.8, maxTokensPerCompletedGoal: 40000 },
  },
  execute: myExecutor,
  judges: { default: modelJudge },
});

console.log(renderGoalEvalMarkdown(report));
if (!report.gate.passed) process.exitCode = 1;
```

`parseGoalEvalSuite` checks a suite loaded from JSON or YAML, including every
case's goal and held-out validators, and reports issues with paths.

### Gate

`gate` thresholds are all optional: `minPassRate`, `minPassK` (every case),
`maxTokensPerCompletedGoal`, `maxCostPerCompletedGoalUsd`,
`maxIntegrityViolations` (default `0`), and `minTrialsPerCase` (default `1`).
`report.gate.passed` is false when any threshold is missed, and
`report.gate.reasons` says which, in plain sentences.

### Derived metrics

Numeric validators can check figures the eval derives from the trace:
`usage.totalTokens`, `usage.costUsd`, `usage.responses`, `run.durationMs`,
`trace.toolCalls`, and `trace.toolErrors` (`GOAL_EVAL_DERIVED_METRICS`). That
lets a goal include its own token budget, which NOVA lists as a numeric
outcome.

## Executors

An executor runs one attempt and returns its output and canonical events. It
gets a ready-made prompt that shows the agent the goal and its visible checks,
never the held-out validators or hidden paths. An executor that throws counts
as a failed attempt, not as a crash of the eval. Executors must not share
state between attempts, or pass^k stops meaning anything.

Generic Corp's executor runs each attempt as a real company request through
the delegation cascade, so the trace holds every agent's turn
(`apps/generic-corp/src/evals.ts`).

### Scoring stored runs

`goalEvalRecordFromRunStore(store, runId, { caseId })` builds an attempt from
a run already in the durable run store: its envelope status, output, and
event log. `scoreGoalEvalTrial` then scores it the same way, so production
runs can be scored after the fact.

## Gaming

NOVA warns that goal-driven models may try to pass a check instead of meeting
it. The eval never trusts an in-run verdict. It re-runs the validators itself
on the attempt's evidence and records these integrity findings, any of which
fails the attempt and, by default, the gate:

| Code | Meaning |
| --- | --- |
| `protected_path_write` | The trace shows a write to the goal's `protectedPaths` (validator scripts, fixtures). |
| `hidden_path_access` | The trace shows any access, read or write, to the case's `hiddenPaths` (answer keys, held-out fixtures). |
| `goal_fingerprint_mismatch` | An in-run goal event carries a `goalFingerprint` that differs from the goal the eval sealed: the run validated against a different definition. |
| `completion_claim_mismatch` | The run reported the goal COMPLETE (`goal.completed`, or `goal.validated` with `status: "COMPLETE"`), but the eval's own validation says INCOMPLETE. |

Held-out validators are the second defense. They run on the same evidence but
are never shown to the agent. An attempt that passes the visible checks and
fails a held-out one is reported as a holdout regression: a sign that the
agent is teaching to the test.

In-run goal events are read by convention: any event whose name ends in
`goal.validated`, `goal.completed`, or `goal.failed` (core or plugin
namespaced) with `data.goalId`, and optionally `data.goalFingerprint` and
`data.status`. Runtimes that gate task completion on validators should emit
them.

These checks read the trace. They are tripwires, not a sandbox: keep answer
keys and validator files outside the agent's workspace as well.

## Benchmarks

Benchmark reports' `pass^k` uses the same estimator as goal evals.

## Baseline comparison

Generic Corp's checkup (`apps/generic-corp/src/baseline.ts`) runs one goal eval
suite under several configurations: a plain single agent with delegation,
offloading, the Python workspace and memory all off, the full company with all
of them on, and optionally the company with each one off in turn. Each
configuration's report gives `efficiency.tokensPerCompletedGoal`, and the
comparison reports each configuration's cut against the single agent. The
validators and the judge are the same everywhere, so results are compared on
what was delivered, not on who did the work. Live runs start only by hand; see
the app's README.
