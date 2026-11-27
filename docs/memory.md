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

## API

- `GET /api/memory`: the handbook and every scope with its entry count.
- `GET /api/memory/:scope`: entries of `company` or an agent id.
- `POST /api/memory/:scope` with `{ "edits": [{ "action": "create|update|delete", "kind": "memory", "id", "title", "content" }], "summary"? }`: owner edits.
- `GET /api/memory/changes?scope=&limit=`: history, newest first.
- `POST /api/memory/changes/:id/undo`: undo a change.

Writes need the `tokens:manage` scope.
