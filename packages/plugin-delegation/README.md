# @generic-ai/plugin-delegation

Durable delegation for Generic AI: persistent agents in an org chart and a
cross-run delegation cascade that survives restarts. Built only on SDK
contracts, so it runs on SQLite or Postgres and on any agent runtime.

## Persistent agents

```ts
import { createAgentDirectory, createStorageAgentStore } from "@generic-ai/plugin-delegation";

const directory = createAgentDirectory({
  store: createStorageAgentStore(postgres.storage), // or createNamespaceAgentStore / createMemoryAgentStore
  root: "/data/agents",
  workspace: { mode: "directory" }, // or { mode: "git-worktree", repository: "/data/repo" }
});

await directory.seed([
  { id: "ceo", role: "ceo", title: "Chief Executive", roleKind: "planner", model: "anthropic/claude-opus" },
  { id: "vp-research", role: "vp", reportsTo: "ceo" },
  { id: "analyst", role: "ic", reportsTo: "vp-research" },
]);
```

Each agent keeps `<root>/<id>/context.md`, a memory file it owns, and
`<root>/<id>/workspace`. Reseeding keeps both and retires agents removed from
the config.

## Delegation cascade

```ts
import {
  createAdapterTaskExecutor,
  createDelegationCascade,
  withRunPersistence,
} from "@generic-ai/plugin-delegation";

const cascade = createDelegationCascade({
  runStore: postgres.runs,
  queue: postgres.queue(),
  directory,
  executor: createAdapterTaskExecutor({
    adapter: withRunPersistence(harness.adapter, postgres.runs),
    harness: harnessConfig,
    context: runContext,
  }),
  validate: ({ outputText }) => ({ passed: outputText.length > 0 }),
});

await cascade.recover(); // re-queue anything a previous process left behind
cascade.start();
const task = await cascade.submit({
  agentId: "ceo",
  instruction: "Plan the launch",
  actor: toRunActor(authContext), // recorded on every task, event and run in the cascade
});
const result = await cascade.wait(task.taskId);
```

Give a task a checkable goal with `goal: { spec }` (an SDK goal spec, see
`docs/goals.md`). The task then only succeeds when its validators report
`COMPLETE`; otherwise the agent gets the validators' feedback and another turn.
Register rubric judges and host checks with the cascade's `goals` option.

An agent turn hands in its work, delegates, or claims the task is impossible.
Each turn gets these tools (`AgentTaskExecutionInput.tools`, passed to the
harness as `hostTools` by `createAdapterTaskExecutor`, so they work on every
runtime):

- `submit_work({ summary, deliverables: [{ path, title? }] })` hands in
  finished work. Only a hand-in finishes a task (`handIn: "tool"`, the
  default); it is checked against the goal, and validators see it as the
  structured output. `checkHandIn` lets the host refuse it during the turn.
- `delegate_task({ tasks: [{ to, task, definitionOfDone?, goal? }] })` records
  hand-offs. It checks the target, the org chart and the limits right away, so
  the agent can fix a bad hand-off in the same turn. It is only offered when the
  agent has someone to delegate to.
- `declare_impossible({ reason })` claims the task is impossible in principle.
  The host's `impossibility` reviewer (ideally on another model) must agree;
  otherwise the agent gets the task back with the reviewer's reasoning.
- `ask_owner({ question, assumption })` writes a question down for the owner
  without pausing; `cascade.answerQuestion` delivers the answer at the next step.
- `set_goal({ objective, definitionOfDone, validators })` is offered while the
  task's goal is still to be drafted (`submit({ draftGoal: true })`). The host
  seals it at once; numeric checks must read host metrics (`goals.metrics`).

The owner can change a goal at any time with `cascade.updateGoal(taskId, edit)`:
it is re-sealed under a new revision, every unfinished task in the cascade is
told at its next step, and a finished root task is reopened. See
`docs/decisions/0069-goals-on-every-request.md`.

Executors that cannot add tools can ignore them; the agent can instead end its
reply with a fenced JSON block, which the cascade still reads:

```json
{"delegate_task": [{"to": "vp-research", "task": "Size the market", "definitionOfDone": "Three sources"}]}
```

or `{"submit_work": {"summary": "...", "deliverables": [{"path": "..."}]}}`, or
`{"declare_impossible": {"reason": "..."}}`. Directives recorded
by the tools win over the reply text, and are saved with the turn's checkpoint.

Children run as their own queued turns (one at a time per agent). The parent
waits in the store, then gets a new turn with every child's result. Delegation
is limited to direct reports by default (`delegationScope: "subtree" | "any"`),
and depth, rounds, fan-out and validation retries are bounded.

To run a fixed team workflow (pipeline, verifier loop, hierarchy, squad) as one
agent's turn, use `createTopologyTaskExecutor` from `@generic-ai/core`, and
`routeTaskExecutor` to pick it for that agent.

See `docs/decisions/0044-persistent-agents-and-delegation-cascade.md`.

Boundaries: this package depends on `@generic-ai/sdk` only and must not import
`@generic-ai/core`.

## Safe resume

Each turn gets a durable journal (`AgentTaskExecutionInput.effectJournal`) that
`createAdapterTaskExecutor` hands to the harness. Tools with an outward effect
(`message.send`, `external.write`, `payment.spend`) are journaled: if a worker
dies and the turn runs again, finished calls return their recorded result, and a
call that started but never reported back is refused with a message telling the
agent to check first. The model's answer is also saved as soon as the turn
succeeds, so a crash before the cascade acts on it does not call the model
again. Goal validations are logged as `plugin.delegation.goal.validated` events
for goal evals. See ADR 0059.

