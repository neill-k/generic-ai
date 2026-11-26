# @generic-ai/continual

The continual harness for the Generic AI native runtime: evidence-backed refinement of supplemental
prompt notes, memories, skills and subagent specs, with history and rollback.

- **State.** `loadHarnessState`, `saveHarnessState` (atomic, owner-only), `mergeHarnessStates`
  (global plus session-local, with `local:` ids on collisions), and the refinement history log.
- **Planner.** `REFINEMENT_SYSTEM_PROMPT`, `parseProposal` (reports truncated JSON), `validateEdit`
  (the base system prompt is protected), `applyRefinementProposal` (refuses entries changed since
  planning) and `rollbackProposal`.
- **Executor.** `planRefinement` (a model pass, or a rollback without one), `reviewAutoRefine` (the
  automatic review gate) and `resolveAutoRefineGates`.
- **Stores.** `loadContinualHarness` and `runRefinement`, the full plan, reload, apply, save and
  record flow, and `parseRefineCommand` for `/refine [--global] [instructions]` and
  `/refine rollback <id>`.
- **Ranking.** `harnessQueryTerms`, `scoreHarnessEntryForQuery` and `formatHarnessStateForPrompt`,
  the block shown in the system prompt.
- **Tools.** `createContinualTools` gives the agent `refine`, `harness_read` and `harness_search`.

Core turns it on for native sessions with the `continual` option; see `docs/continual-harness.md`.

Adapted from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (MIT). See
`THIRD_PARTY_NOTICES.md`.
