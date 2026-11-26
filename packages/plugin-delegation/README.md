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

An agent turn either replies with its result, gives up with
`{"finish_task": {"status": "failed", "reason": "..."}}`, or delegates by ending
with a fenced JSON block:

```json
{"delegate_task": [{"to": "vp-research", "task": "Size the market", "definitionOfDone": "Three sources"}]}
```

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
