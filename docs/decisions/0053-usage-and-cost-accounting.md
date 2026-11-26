# 0053. Usage and Cost Accounting

## Context

The native model layer (`@generic-ai/ai`) reports tokens and dollar cost on every
assistant message, but nothing carried those numbers past the agent loop. Runs
could not be compared on spend, `AgentHarnessBudget.maxTokens` and
`maxCostUsd` were declared but never enforced, and the Generic Corp dashboard
had no cost data to show. Neill's NOVA paper promises a large cut in tokens, and
that claim is judged on tokens spent per goal achieved, so the harness needs
that figure as a first-class measure.

## Decision

- **Canonical events.** A new `usage` event family with two core names:
  - `usage.recorded`, one per model response, with `provider`, `model`, the
    response's `usage` (same shape as `@generic-ai/ai`'s `Usage`), and optional
    `agentId`, `roleId`, `goalId`, `responseId`, `stopReason`.
  - `usage.budget.exceeded`, emitted once per run when a cap is reached, with
    the breached limits and the run's totals at that point.
  The SDK and core taxonomies both gain the family.
- **Rollups live in the SDK.** `createUsageLedger()` and
  `summarizeUsageEvents()` roll usage up per run, per agent (the `agentId`, or
  the session id), per goal, and per model, deterministically. Goal outcomes are
  read from `goal.completed` / `goal.failed` / `goal.cancelled` events (core or
  plugin namespaced) and from terminal `run.*` events that carry a `goalId`; a
  `goalId` on `run.created` or `run.started` attributes the run's later usage to
  that goal.
- **Headline measure.** `tokensPerCompletedGoal` is every token spent on goals,
  including failed, cancelled, and still-open ones, divided by completed goals.
  Charging failures keeps the number honest: a harness that burns tokens on
  failed attempts looks worse, not better. `costPerCompletedGoalUsd` is the
  dollar equivalent.
- **Budgets stop runs at response boundaries.** `createUsageMeter()` in core
  meters a run, emits the events, and aborts its `signal` with a
  `UsageBudgetExceededError` once total tokens or dollars reach a cap. A cap is
  reached when the total is greater than or equal to it. The response that
  crossed the cap is still counted, since it has already been paid for. Caps are
  per run, shared by every agent in it. The native runtime adapter accepts
  `budget` on `run()` and reports `usage` on its result.
- **Observability.** `usage.recorded` records keep their token and dollar
  figures (numbers, not content, so they fit the metadata-only posture). The
  catalog adds `generic_ai.model.tokens`, `generic_ai.model.cost.usd` (by
  provider and model) and `generic_ai.usage.budget_stops.count` (by limit), and
  each run record keeps a running `metadata.usage` rollup.
- **Benchmark reports.** `BenchmarkTrialResult.usage` records a trial's spend
  and goals; reports add a per-candidate and report-level usage summary and a
  "Usage and Cost" Markdown section led by tokens per completed goal.

## Consequences

- Harness runs on the native adapter share one meter per run across the root
  session, every `delegate_agent` session, and every topology actor. Caps come
  from `AgentHarnessBudget.maxTokens` / `maxCostUsd` (run context first, then
  the run input; `runAgentHarnessTopology` takes `budget`). A reached cap aborts
  every session, the run fails with `errorCategory: "budget_exceeded"`, and the
  result carries `usage`. A budget abort is never retried. A topology run with a
  sealed goal charges every actor's spend to that goal and records its outcome, so
  `usage.goals.tokensPerCompletedGoal` is filled in. The pi adapter does
  not report usage through the meter yet.
- Model calls made by context compaction are not metered yet.
- Tool results that report nested usage are not counted, to avoid double
  counting delegated sessions that meter themselves.
- Costs are list-price estimates from the model catalog, not provider invoices.
