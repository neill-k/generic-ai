# Memory in Generic Corp

Generic Corp has one memory system (design decision 17). It replaces the per-agent `context.md`
notes file in the app; the framework's `plugin-memory-files` store and the session-local continual
harness are not used by the app.

## Two layers

- **The company handbook** (scope `company`). Every agent reads it at the start of every turn: who
  the owner is, how he likes things done, facts about the company. The owner writes it, and the
  background preference scanner adds what it finds in his chats. The owner's permissions and
  standing rules are not here: they live in the permissions store and are briefed to agents
  separately.
- **Private memory per agent** (scope `agent:<id>`). What an agent has learned doing its job. The
  agent writes it with `remember` and `forget` and searches it, with the handbook, with `recall`.
  Dreaming consolidates it while the agent is idle.

Entries use the continual harness shape from `@generic-ai/continual` (prompt notes, memories,
skills and subagent specs), so the refine planner ported from Prime Agent can work on them offline.
Each turn's prompt gets the whole handbook (up to 8,000 characters) and the agent's prompt notes,
skills and 25 memories ranked by relevance to the task.

## Where it came from, history and undo

Every entry carries `metadata.origin`: `owner`, `agent` (with the task id), `chat` (with the owner
message), `dream`, `import` or `undo`. Every change is recorded with each entry before and after
it. Undo restores the entries a change touched; an entry that changed again since is left alone and
reported, so an undo never silently overwrites later work. Only the owner undoes.

On first use of an agent's memory, notes it wrote in its old `context.md` are imported as one entry,
"Notes from before the memory system".

## Who may change what

The store enforces this (`refuseMemoryEdit` in `apps/generic-corp/src/memory.ts`), whatever a
prompt or tool asks:

| Actor | May write |
| --- | --- |
| Owner | Anything. An entry the owner wrote or edited is locked against everyone else. |
| Preference scanner | Unlocked handbook and agent memories and prompt notes. |
| Agent | Its own memories only. |
| Dreaming | The dreaming agent's own unlocked memories, prompt notes, skills and subagent specs. Never the handbook, another agent, goal checks, permissions or standing rules (decision 41). |

Memory is kept in host storage (`generic-corp-memory` key-value namespace), outside the company
folder that agent tools and shells are rooted at, so agents change it only through their tools.

## The preference scanner (decision 18)

Every 15 minutes, and only when the owner has sent new messages, a small model (Claude Haiku by
default; `GENERIC_CORP_MEMORY_MODEL` changes it) reads up to 30 new owner messages and files each
lasting preference as a prompt note: in the handbook when it applies to everyone, or in one agent's
memory when it is only about that agent's work. Each one points at the message it came from and
quotes the owner's words. Most messages hold none, and an empty answer is the usual one. It can
update an earlier preference when the owner changes his mind, but never an entry he wrote or
edited. It never writes permissions.

## Dreaming (decision 19)

When an agent has been idle for 30 minutes, at most every 6 hours, and only when it has new saved
sessions or harvested scripts since its last dream, a background job rereads its 4 most recent
sessions (`<dataDir>/sessions/<agent>/`) and new scripts and runs the refine planner ported from
Prime Agent (`@generic-ai/continual`) offline. The planner keeps what is worth keeping, merges
duplicates, drops what turned out wrong, and saves procedures. The handbook is shown to it as
read-only context. One dream is one recorded change, so the owner undoes a whole dream with one
click. At most one agent dreams at a time.

## Script harvesting (decision 28)

The scripts an agent writes with `write` and `edit` (`.sh`, `.py`, `.js`, `.ts` and friends, or
anything under `scripts/` or `bin/`) are noted against the task. When the task is accepted, they are
copied with their checksum to `<dataDir>/harvest/`, outside the company folder, so a later edit by
the agent does not change them; scripts from failed or cancelled tasks are dropped. Dreaming sees
new harvested scripts and can save one as a skill (`metadata.harvestId`, with `{script}` in its
command). Before every turn, the agent's saved procedures are laid out as skill folders in
`agents/<id>/.agents/memory-skills/`, rebuilt from memory each time, so undoing a dream removes the
skill from the next turn.

## Keeping background work cheap

Both jobs run only while workers run, use a small model, call it only when there is something new,
and stop while paused (`PUT /api/memory/background {"paused": true}`, or the Pause button on the
memory page). `canSpendInBackground` on the server is where spending limits and the company pause
plug in. Calls and tokens are tallied per job at `GET /api/memory/background`. No automated test
calls a real model; tests use scripted replies.

## API

- `GET /api/memory`: the handbook and every scope with its entry count.
- `GET /api/memory/:scope`: entries of `company` or an agent id.
- `POST /api/memory/:scope` with `{ "edits": [{ "action": "create|update|delete", "kind": "memory", "id", "title", "content" }], "summary"? }`: owner edits.
- `GET /api/memory/changes?scope=&limit=`: history, newest first.
- `POST /api/memory/changes/:id/undo`: undo a change.
- `GET /api/memory/background`, `PUT /api/memory/background`: settings (pause, scanner and
  dreaming on or off, intervals) and each job's last run and usage.
- `POST /api/memory/background/scan`: scan the owner's chats now.
- `POST /api/memory/background/dream/:agentId`: dream for one agent now.

Writes need the `tokens:manage` scope.
