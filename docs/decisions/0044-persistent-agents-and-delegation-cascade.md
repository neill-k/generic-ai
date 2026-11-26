# 0044 — Persistent agents and the durable delegation cascade

- Status: accepted
- Date: 2026-11-26
- Roadmap items: R8 (persistent agents) and R9 (cross-run delegation cascade)
  of the Generic Corp production roadmap.
- Related: `0043-durable-run-store-and-queue.md`, `0042-protocol-topology-runner.md`,
  `0035-sdk-contracts.md`

## Context

Generic Corp is a company of persistent agents. The owner gives the CEO a
goal, the CEO hands work to VPs, VPs to individual contributors, and results
come back up. That work can take hours and must survive restarts and deploys.
Before this change, delegation only existed inside one harness run (the
`delegate_agent` tool and the topology runner), so a parent had to stay in
memory while its children worked, and nothing outlived the process. Agents had
no identity between runs: no memory, no workspace, no place in an org chart.

ADR 0043 added the durable run store and queue. This decision uses them.

## Decision

1. **Delegation lives in `@generic-ai/plugin-delegation`.** Core stays a
   kernel. The plugin depends only on SDK contracts: `RunStoreContract`,
   `DurableQueueContract`, `createQueueWorker`, `AgentHarnessAdapter`, and a new
   `AgentTaskExecutor` contract in the SDK. It therefore runs on SQLite or
   Postgres, and on Pi or the native runtime, without changes.
2. **Persistent agents are records, seeded from config.** `createAgentDirectory`
   stores agents (id, role, title, `reportsTo`, instructions, model, harness role
   kind) through a small `AgentRecordStore` (adapters for the SDK
   `StorageContract`, the SQLite and memory key-value namespaces, and memory).
   Seeding upserts, keeps each agent's home, and retires agents that left the
   config. Each agent gets `<root>/<id>/context.md` (its own memory file) and
   `<root>/<id>/workspace` (a directory, or a git worktree on branch
   `agent/<id>`). The agent's home is its harness `workspaceRoot`, so it can edit
   its own memory with its normal file tools.
3. **Tasks are runs.** A delegated task is a run-store record (`kind:
   agent-task` metadata, the task in the run's metadata, the result in the run's
   output envelope) with an event log of canonical `run.*`, `session.*` and
   `delegation.*` events. Optimistic versioning makes concurrent updates safe.
4. **Turns are queue jobs.** Each turn of a task is one job with
   `concurrencyKey = agent:<id>` (one running turn per agent, as in the original
   Generic Corp), a deterministic id and idempotency key per task round, and
   priority by depth so cascades finish before new ones fan out. Retries,
   backoff, leases and dead-lettering come from the queue.
5. **Delegation is a directive, not an in-memory call.** A turn either finishes
   (its reply is the result), gives up with a `finish_task` JSON block, or ends
   with a `delegate_task` JSON block. Child tasks are created with deterministic
   ids, enqueued, and the parent moves to `waiting` and releases its worker. When
   the last child settles, the parent is re-queued for a new round whose prompt
   includes every child's result or failure. Directives are read with the SDK's
   `parseActorDirectives`, so any runtime can drive the cascade. Since ADR 0060
   agents get real `delegate_task` and `finish_task` tools that record the same
   directives; the JSON block remains the fallback.
6. **Guard rails are enforced by the scheduler, not the prompt.** Delegation is
   limited to direct reports by default (`subtree` and `any` are options),
   delegating to an agent already waiting on the same chain is refused (it would
   deadlock), and depth, round, fan-out and validation limits apply. Refusals go
   back to the agent as feedback rather than failing the task.
7. **Goals gate completion.** Every task carries an optional goal shown to the
   agent. When the goal has an R24 goal spec (ADR 0050), the spec is sealed and
   fingerprinted on the task record when the task is created, and the task only
   succeeds once `runGoalValidators` reports `COMPLETE` for the turn's output and
   trace; `INCOMPLETE` re-queues the task with the report's feedback, up to a
   limit. Managers can attach specs to the work they delegate. An extra
   `validate` hook runs after the goal passes.
8. **Runs are persisted for any adapter.** `withRunPersistence` wraps any
   `AgentHarnessAdapter` so each harness run is stored with its envelope, event
   log and session. `createAdapterTaskExecutor` runs each turn as a single-role
   harness with the agent's role kind and model (models per role).
9. **Topologies run inside a task.** Core's `createTopologyTaskExecutor` runs a
   protocol topology as one task turn. With a checkpoint store it saves each
   action outcome, and `runHarnessTopology` gains `resumeFrom`, so a retried or
   crashed turn keeps the actions that succeeded and runs only the rest.

10. **Every record says who asked.** `submit` takes the caller's `RunActor`
   (from `toRunActor(authContext)`, ADR 0045). The root task, every delegated
   task, their event logs, each executor turn, and each persisted harness run
   carry that actor, so approvals and audit can tell who started the work.

## Consequences

- A cascade survives restarts: tasks, rounds and children are in the store,
  turns are in the queue, and `recover()` re-queues anything whose job went
  missing. Tests cover a crash with an abandoned lease and a restart on a new
  process, plus two workers sharing one Postgres database.
- Turns are at-least-once, but safe to repeat (ADR 0059): the model's answer is
  checkpointed before the cascade acts on it, and outward tool calls are
  journaled so a retried turn replays finished calls instead of repeating them
  and refuses ones whose outcome was never recorded.
- Waiting parents hold no worker, lease or memory, so deep org charts do not
  deadlock the worker pool.
- Inter-agent messages outside the task tree (a board, direct messages) are not
  part of this change; `plugin-messaging` remains the place for them.

## Alternatives considered

- Keep the parent turn open and block on children. Rejected: a restart would
  lose the parent, and a deep cascade would exhaust workers.
- Put the cascade in core. Rejected: core is the kernel and the package
  boundaries assign delegation semantics to the delegation plugin.
- Tool-based delegation only. Rejected for now: tools are runtime-specific
  until the native harness lands, while directives work on every adapter.
