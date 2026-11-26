# @generic-ai/autonomy

Long-running work for the Generic AI native runtime.

- **Thread goals.** `GoalDriver` holds one persistent objective with an optional token budget. After each turn it hands back a continuation prompt until the goal is complete, paused, budget-limited or failed. Three turns in a row without output end the goal with an error, with a doubling backoff between them. Reaching the budget marks the goal `budget_limited` and gives the agent one wrap-up turn.
- **Goal tools.** `createGoalTools(driver, { verify })` gives the agent `get_goal`, `create_goal` and `complete_goal`. A `verify` hook runs host-owned checks on a completion claim, and a failed check keeps the goal active with the feedback.
- **Autonomous mode.** `AutonomousDriver` keeps a run going with no human input until its quality gates pass or a limit is reached (continuations, turns, tokens, time). A failed gate is fed back to the agent with its output. A gate is not rerun while the git working tree is unchanged since it failed.
- **Gate runner.** `createShellGateRunner({ cwd })` runs gate commands in a clean environment built from an allowlist, so a gate cannot read the server's secrets. `inheritProcessEnv: true` is the explicit opt-in.
- **One goal mechanism.** Core wires `verify` and the gates to the SDK goal runner: a native session's goal is an SDK goal spec, `complete_goal` runs `runGoalValidators`, and gate commands become `check` validators (ADR 0063).
- **Controller.** `LongRunController` combines both: an active goal drives the session first, then autonomous mode.

The goal state, prompts and driver and the autonomous limits, gates and decisions are adapted from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (MIT). See `THIRD_PARTY_NOTICES.md`.
