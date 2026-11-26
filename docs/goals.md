# Goals And Validators

A goal is an objective plus a definition of done that machines can check. Give
an agent a goal and a way to verify it, and let it keep working until the
verification says `COMPLETE`. This page describes the SDK contract and the
validator runner in `@generic-ai/sdk` (`packages/sdk/src/goals/`).

Delegated tasks are gated on these goals: in `@generic-ai/plugin-delegation`,
a task whose goal carries a `spec` only succeeds once the runner reports
`COMPLETE`; otherwise the agent gets `report.feedback` and another turn (see
"Goal-gated tasks" below).

## Goal spec

```ts
import { sealGoal } from "@generic-ai/sdk";

const goal = sealGoal({
  id: "q3-report",
  objective: "Write the Q3 revenue report.",
  definitionOfDone: ["Every region is covered", "Totals reconcile with the ledger"],
  validators: [
    { id: "coverage", kind: "numeric", source: { metric: "regionCoverage" }, operator: "gte", value: 1 },
    {
      id: "quality",
      kind: "rubric",
      criteria: [
        { id: "clarity", description: "Plain, skimmable prose" },
        { id: "accuracy", description: "Numbers match the ledger", required: true, weight: 2 },
      ],
      passThreshold: 0.8,
    },
    { id: "read-ledger", kind: "trace", require: [{ tool: "read_file", argsInclude: { path: "ledger.csv" } }] },
    {
      id: "shape",
      kind: "output_schema",
      schema: { type: "object", required: ["total"], properties: { total: { type: "number" } } },
    },
    { id: "tests", kind: "check", checkRef: "npm-test" },
  ],
  protectedPaths: ["validators/"],
});
```

A goal must have at least one validator. A definition of done without a check
is not verifiable, so the spec is rejected.

### Validator kinds

| Kind | Checks | Subject |
| --- | --- | --- |
| `numeric` | A number against `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, or `between` (with optional tolerance) | A reported metric, or a dot path into structured output or an artifact |
| `rubric` | Weighted criteria scored 0 to 1 by a judge (model or human); per-criterion `required` and `passScore` | The final output text or an artifact |
| `trace` | Required actions appear (optionally in order, with min/max counts) and forbidden actions do not | The run trace: tool calls, events, roles, tool args |
| `output_schema` | Structured output conforms to a JSON Schema subset | The final output or an artifact, parsed as JSON |
| `check` | A host-registered deterministic check: tests, a CLI, a script | Whatever the check reads from the evidence |

Every validator is required by default. Set `required: false` to make it
advisory: it is reported but never blocks `COMPLETE`. `fixHint` adds fixed
remediation text to the validator's failure message.

## Running validators

```ts
import { goalTraceFromProjections, runGoalValidators } from "@generic-ai/sdk";

const report = await runGoalValidators(
  goal,
  {
    outputText: result.outputText,
    metrics: { regionCoverage: 1 },
    trace: goalTraceFromProjections(result.projections),
    artifacts: { memo: memoText },
  },
  {
    judges: { default: myModelJudge },
    checks: { "npm-test": runNpmTest },
  },
);

if (!report.complete) {
  // Send report.feedback back to the agent and let it keep working.
}
```

The report carries `status` (`COMPLETE` or `INCOMPLETE`), one result per
validator, a summary, and `feedback`: ready-to-send text that lists each
blocking check, what was observed, and how to fix it. A validator that cannot
run (no judge registered, a check that throws or times out, malformed judge
output) reports `error`, which blocks completion when the validator is
required. The runner itself never throws for validator failures.

Trace evidence comes from `goalTraceFromProjections` (an
`AgentHarnessRunResult`'s `projections`) or `goalTraceFromCanonicalEvents`
(raw canonical events, including runtime `tool_execution_start/end` events).

## Rubric judges

A judge is a function `(request) => GoalJudgment`. For a model judge, build the
prompt with `buildRubricJudgePrompt`, request structured output with
`goalJudgmentJsonSchema`, and parse the reply with `parseGoalJudgment`. Judges
should set `improvement` for any score below 1; the runner surfaces it to the
agent as the fix. The runner re-checks judge output against the schema and
reports an error when a criterion is unscored.

## Keeping validators out of the agent's reach

Goal-driven agents may try to pass a check instead of meeting it. The contract
defends against that in layers:

- `sealGoal` validates the spec, deep-copies it, freezes it, and fingerprints
  its canonical JSON with sha256. Only goals created by `sealGoal` are
  accepted by `runGoalValidators`; a look-alike object throws
  `GoalTamperError`.
- The runner re-hashes the goal before and after running validators and
  refuses a goal whose fingerprint changed. Hosts that store the fingerprint
  separately (for example on the task record) can pass `expectedFingerprint`.
- `rubric` and `check` validators only name a judge or check. The
  implementation is registered by the host when it calls the runner, so the
  agent cannot change what runs.
- `protectedPaths` lists validator scripts, fixtures, and expected outputs.
  The runner adds a required `integrity.protected-paths` result that fails if
  the trace shows a write-like file tool or a shell write touching those paths.
  This is a tripwire, not a sandbox: hosts should also keep those files
  read-only or outside the agent's workspace.

Hosts should keep the sealed goal in host memory or storage, never in a file
or message the agent can write, and should not expose a tool that lets the
agent submit or replace its own goal.

## Structured-output schemas

The SDK exports three JSON Schemas, frozen under `contracts/goals/`:

- `goalSpecJsonSchema` - for planners that draft goals for review, or YAML/JSON
  config loaders.
- `goalJudgmentJsonSchema` - the structured output a rubric judge returns.
- `goalValidationReportJsonSchema` - the runner's report.

`checkAgainstJsonSchema` is the dependency-free checker behind `parseGoalSpec`
and the `output_schema` validator. It supports `type`, `enum`, `const`,
`properties`, `required`, `additionalProperties`, `items`, array, string, and
number bounds, `pattern`, `anyOf`, `oneOf`, `allOf`, `not`, and local `$ref`.
Errors carry a JSONPath and a message written for the agent to act on.

## Evals

[Goal evals](goal-evals.md) replay goals over repeated attempts and score
each attempt from its trace: pass rate, pass^k, NOVA's three checks, tokens
per completed goal, held-out validators, and integrity findings.

## Prompting

`describeGoalForAgent(goal)` renders the objective, definition of done, every
check with its threshold, and the protected paths. Thresholds are shown on
purpose: the agent needs to know how it will be verified.

## Goal-gated tasks

The delegation cascade (`createDelegationCascade`, ADR 0044) wires goals into
task completion:

- `cascade.submit({ goal: { spec } })` seals the spec and stores it, with its
  fingerprint, on the task record. An invalid spec is rejected at submit time.
- A manager agent can attach a spec to delegated work with a `goal` field on a
  `delegate_task` entry. An invalid spec goes back to the manager as feedback.
- When the agent finishes a turn, the cascade re-seals the stored goal, checks
  the fingerprint, and runs `runGoalValidators` with the turn's output text,
  structured output (the last fenced JSON block), and trace (the canonical
  events of the turn's persisted harness runs). Pass judges, checks, and extra
  evidence (metrics, artifacts) through the cascade's `goals` option.
- `INCOMPLETE` re-queues the task with the report's feedback, up to the goal's
  `maxAttempts` (or the cascade's `maxValidationAttempts`); then the task fails
  and the failure bubbles to its parent. The latest report summary is kept on
  the task as `lastGoalReport`.
- A goal whose stored spec no longer matches its fingerprint never validates.

## Topologies

`runHarnessTopology()` and `runAgentHarnessTopology()` take `goal` and
`goalValidators`. The verifier loop validates each candidate against the goal
before (or instead of) its critic, and every protocol only succeeds when the
goal is `COMPLETE` on the final output. See "Goals decide when a topology is
done" in [harness-dsl.md](harness-dsl.md).


## Long-running native sessions

A native session can pursue a goal across many turns (`goal` on
`runCapabilityNativeAgentSession`, from `@generic-ai/autonomy`; ADR 0063). It
uses the same goal spec and the same runner as tasks and topologies, so one
goal behaves the same whichever of the three pursues it:

- `goal: { spec, validation }` takes a sealed goal and the judges and checks
  for its validators. The goal's id, objective, definition of done and checks
  become the session's thread goal, and the session keeps continuing it until
  it is complete, its token budget runs out, or turns stop making progress.
- The agent claims completion with the `complete_goal` tool. The claim runs
  `runGoalValidators` on the session's output and trace. `INCOMPLETE` keeps the
  goal active and returns the report's feedback to the agent; only `COMPLETE`
  ends it.
- Autonomous mode (`autonomous`) keeps a session going with no human input.
  Its gate commands become `check` validators of the same goal, so a gate and
  a validator are one kind of thing, run by one runner. A gate command runs in
  the clean agent-command environment.
- Each validation emits a `native.goal_validation` event with the report's
  status and summary.

A topology run does not hand its goal to every actor as a thread goal: the
goal belongs to the team, and the topology runner checks it once per attempt
with the same runner.
