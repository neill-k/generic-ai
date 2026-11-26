# Continual harness

The continual harness lets a native session improve its own working context from evidence. It
holds four kinds of entries:

- **prompt**: a supplemental note added to the system prompt (the base prompt itself can't be edited)
- **memory**: a durable fact or preference
- **skill**: a repeatable procedure, with a `reference` that names a shell command or an installed
  skill, and an `arguments` contract
- **subagent**: a spec the agent turns into a task prompt for `spawn_agent`

It is a port of Prime Agent's `/refine` (MIT, see `packages/continual/THIRD_PARTY_NOTICES.md`).

## Turning it on

```ts
await runCapabilityNativeAgentSession({
  // ...
  continual: {
    globalDir: "/data/harness",       // shared by every session
    localDir: "/data/sessions/abc.harness", // optional: defaults to <session file>.harness
    autoRefine: { turnInterval: 25 }, // or false
  },
});
```

The harness takes the same option as `native.continual`.

## Stores

Each store is a directory with `harness_state.json` (the entries) and `refinement_history.jsonl`
(every refinement, with each entry before and after). The agent sees the global and local stores
merged. When a local id collides with a global one, the local entry shows as `local:<id>`.

Local refinements are the default and are for this session's progress, blockers and project facts.
Global refinements are for stable cross-session lessons, durable preferences and reusable skills or
subagents. A session without a local store (an in-memory session with no `localDir`) can only
refine globally.

## What the agent sees

The system prompt gets a "Continual Harness State" block: for each kind, its count and the three
entries most relevant to the session's prompt (ranked by term overlap weighted by how rare each term
is), plus the last ten refinements. The agent has three tools:

- `refine` asks for a refinement (`instructions`, `global`, or `rollback_id`). It runs when the
  current turn ends, because the planner reads the whole conversation.
- `harness_read` returns an entry in full.
- `harness_search` ranks all entries against a query.

After a refinement that changed something, a hidden `[user-refinement]` or `[auto-refinement]`
notice is added to the conversation and the system prompt is rebuilt.

## Commands

A session prompt of `/refine [--global] [instructions]` runs a refinement directly, without a model
turn, and returns the notice as the output. `/refine rollback <id>` reverts an earlier refinement in
the store it wrote.

## How a refinement runs

1. The planner gets the merged state, the last 20 refinements, the last 80,000 characters of the
   conversation (trimmed further to fit the model's context), the scope policy and any instructions,
   and returns JSON edits. A reply cut off at its output limit is an error, never half-applied.
2. The target store is reloaded. Each edit is validated (the base system prompt is protected, skills
   need a reference and arguments) and refused if its entry changed since planning began.
3. The store is saved atomically (owner-only permissions) and the result is appended to its history.

Events: `native.harness_refined` (id, source, scope, applied and failed counts) and
`native.harness_refine_failed`. The planner's and reviewer's spend is recorded on the usage meter
with purposes `refinement` and `refinement_review`.

## Automatic refinement

Unless `autoRefine` is `false`, a short review call runs after a compaction and every 25 assistant
turns, at most once every 20 minutes, and only when the session has a local store. If the reviewer
approves, a local refinement runs with its instructions. Tune it with `turnInterval`, `compact`,
`cooldownMs` and `enabled`.

## Differences from Prime Agent

- Skill entries reference shell commands or installed skills, not Python REPL callables.
- Prime's `factory` kind (state-machine workflows in its Python kernel) is not ported.
- Local history is kept in the local store's `refinement_history.jsonl`, not in the session file.
