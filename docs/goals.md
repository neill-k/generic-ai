# Goals And Validators

A goal is an objective plus a definition of done that machines can check. Give
an agent a goal and a way to verify it, and let it keep working until the
verification says `COMPLETE`. This page describes the SDK contract and the
validator runner in `@generic-ai/sdk` (`packages/sdk/src/goals/`).

Status: contract and runner only. Wiring the runner into task completion (so
`finish_task` is gated on `COMPLETE`) is separate work in the core harness and
queue.

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

## Prompting

`describeGoalForAgent(goal)` renders the objective, definition of done, every
check with its threshold, and the protected paths. Thresholds are shown on
purpose: the agent needs to know how it will be verified.
