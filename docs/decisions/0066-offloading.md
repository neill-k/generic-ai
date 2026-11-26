# 0066 — Offloading tool results, batching calls and harvesting scripts

- Status: accepted
- Date: 2026-11-26
- Related: `0063-one-goal-mechanism-for-long-running-sessions.md`, `0064-agent-isolation-on-railway.md`,
  `docs/offloading.md`, roadmap item R25

## Context

NOVA's second principle is to move work out of the model: large tool results to files, and scripts
that worked saved as reusable tools. Native tools already truncate at 50 KB or 2,000 lines, which
still costs about 12,000 tokens per long result, and every independent call costs a model turn.

## Decision

1. `@generic-ai/tools` gains `withOffload`, on by default in native sessions: results over 16,000
   characters are saved to a temp output file (the existing `generic-ai-<tool>-<hex>` files the
   confined `read` tool may open) and replaced with a head, a tail and the path.
2. `tool_batch` (opt-in) runs up to 10 independent calls in one step through each tool's own
   `execute`, so the policy and hook wrappers still apply. The host does not run model-written code
   in-process for "programmatic tool calling"; scripts run through `bash` with the agent's isolation.
3. Core harvests scripts the agent wrote when the run passes its goal's validators, using the same
   validation report that decides `complete_goal` (ADR 0063). `promoteScriptToSkill` turns one into
   a skill with documented flags. Promotion is a host call, not an agent tool.

## Consequences

- Long results cost about 600 tokens plus a read of the part the agent needs.
- An offloaded file lives in the temp directory until the OS cleans it.
- Harvested scripts are only as trustworthy as the validators that passed; promotion stays a
  deliberate step.
