# 0067 — The continual harness

- Status: accepted
- Date: 2026-11-26
- Related: `0063-one-goal-mechanism-for-long-running-sessions.md`, `0066-offloading.md`,
  `docs/continual-harness.md`, `docs/planning/native-harness-parity.md` (slice 7)

## Context

Prime Agent's continual harness lets an agent improve its own working context from evidence: small
edits to supplemental prompt notes, memories, skill entries and subagent specs, kept with a history
that can be rolled back. Parity with Prime needs it, and it is the natural home for lessons a
Generic Corp agent learns across runs.

## Decision

1. A new runtime package, `@generic-ai/continual`, ports Prime's refinement module: state, merge,
   history, planner prompt and validation, apply with a stale check, rollback, relevance ranking,
   the system prompt digest and the automatic review gate. It depends only on `@generic-ai/ai` and
   `@generic-ai/agent`.
2. Two stores: a global one shared by sessions and a local one per session (by default next to the
   session's JSONL file). Local is the default scope; global refinements are for durable lessons.
   Global entries are read-only context to a local refinement. A session without a local store can
   only refine globally.
3. Refinements are planned by a separate model call that sees the conversation, the merged state
   and the history, after the turn that asked for one (the `refine` tool) or directly for a
   `/refine` prompt. The target store is reloaded before applying, and an entry that changed since
   planning began is refused rather than overwritten.
4. The base system prompt is immutable. Prompt entries are supplemental notes only.
5. Skill entries name a shell command (`{"type":"command"}`) or an installed skill
   (`{"type":"skill"}`) instead of a Python callable, and subagent specs are started with
   `spawn_agent`. Prime's `factory` kind is not ported, because it needs Prime's Python kernel.
6. The automatic review runs after a compaction and every 25 assistant turns, at most once per 20
   minutes, and only refines the local store. Its spend is metered as `refinement_review`, and
   refinement passes as `refinement`.

## Consequences

- Lessons persist across runs without editing roles or prompts by hand, and every change can be
  traced and rolled back by id.
- Refinement costs extra model calls; `autoRefine: false` keeps only explicit refinements.
- Agent-written entries reach later system prompts, so the global store should be writable only by
  agents the operator trusts with cross-session influence.
