# 0063 — One goal mechanism for long-running native sessions

- Status: accepted
- Date: 2026-11-26
- Related: `0044-persistent-agents-and-delegation-cascade.md`, `0058-goal-evals.md`,
  `docs/goals.md`, `docs/planning/native-harness-parity.md` (slice 6)

## Context

The SDK already defines goals: a sealed goal spec with host-owned validators,
and `runGoalValidators`, which returns `COMPLETE` or `INCOMPLETE` with feedback.
The delegation cascade, the topology runner and the goal evals all use it.

Native harness slice 6 ports Prime Agent's long-running work: a thread goal
with a token budget, continuation prompts, a no-progress cap, a `goal.complete()`
call, and autonomous mode with shell quality gates. Ported as is, that would be
a second goal mechanism with its own idea of "done".

## Decision

1. The runtime package `@generic-ai/autonomy` keeps what Prime Agent adds that
   the SDK does not have: the continuation driver, token budget, no-progress cap
   and backoff, autonomous limits, and the rule that a failed gate is not rerun
   on an unchanged working tree. It cannot depend on the SDK (runtime packages
   never do), so completion is a `verify` hook there.
2. Core wires that hook to the SDK. A native session's goal takes a sealed SDK
   goal; its id, objective, definition of done and checks become the thread
   goal, and `complete_goal` runs `runGoalValidators`.
3. Autonomous gate commands become `check` validators of the same goal, run by
   the same runner. Autonomous mode has one gate, "the goal's validators pass".
4. A topology run's goal is not handed to each actor. It is the team's goal and
   the topology runner keeps checking it.

## Consequences

- A goal set in the Generic Corp app means the same thing whether a delegated
  task, a team workflow or a long-running native session pursues it, and evals
  can score all three from the same reports.
- Shell gates gain the SDK's report format, advisory validators and fix hints.
- A plain objective without a spec still works, for a session where the agent
  creates its own goal. Its completion is then not checked unless gates are set.
