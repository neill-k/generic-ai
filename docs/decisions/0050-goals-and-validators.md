# 0050. Goals And Validators

## Context

Production agents are most reliable when they are given a goal and a way to
verify it, the same shape models are trained on, and are allowed to keep
working until the verification passes. Generic AI had benchmark graders and a
verifier-loop protocol, but no runtime contract for a task's definition of
done, no way to express "the agent must have read the ledger", and no
guarantee that an agent could not edit the checks it is judged by.

## Decision

Generic AI adds an SDK-owned goal contract and validator runner
(`packages/sdk/src/goals/`, documented in `docs/goals.md`):

- `GoalSpec`: objective, plain-language definition of done, and at least one
  validator. Validator kinds are `numeric`, `rubric` (judge-scored criteria),
  `trace` (required and forbidden actions in the run trace), `output_schema`
  (JSON Schema subset), and `check` (host-registered deterministic checks).
- `sealGoal`: validates, deep-copies, freezes, and sha256-fingerprints a goal.
  `runGoalValidators` only accepts sealed goals and re-verifies the
  fingerprint before and after running.
- Judges and checks are named in the goal but implemented by the host at run
  time, so the agent cannot change what runs. `protectedPaths` adds a required
  integrity result that fails on trace evidence of writes to validator files.
- `runGoalValidators` never throws for validator failures. It returns
  `COMPLETE` or `INCOMPLETE` with per-validator results and feedback text
  that tells the agent what failed and how to fix it.
- Frozen JSON Schemas for goal specs, judge output, and validation reports
  live in `contracts/goals/`.

The kernel does not interpret goals in this slice. Gating task completion on
`COMPLETE` belongs to the runtime and queue integration, which consumes this
contract.

## Consequences

- Hosts can attach a verifiable definition of done to any task, coding or not.
- Model judges get a fixed structured-output schema and prompt builder.
- Protected-path detection is a heuristic over the trace. It complements, and
  does not replace, read-only mounts or keeping validator files outside the
  agent's workspace.
- The JSON Schema checker is a deliberate subset. Unsupported keywords are
  ignored, as JSON Schema requires, so goals that need full draft 2020-12
  semantics should use a `check` validator.

## Alternatives Considered

- Use zod schemas for goals. Rejected because goals must be serializable
  (YAML config, task records) and validator output must be plain JSON.
- Let agents call validators as tools and trust their reports. Rejected
  because the agent would control both the work and the verdict.
- Put goal evaluation in the kernel. Rejected for this slice to keep the
  contract package-owned and to avoid colliding with in-flight runtime work.
