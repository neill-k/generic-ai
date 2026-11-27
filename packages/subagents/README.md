# @generic-ai/subagents

Subagents and agent messaging for the Generic AI native runtime, following Prime Agent's
(`PrimeIntellect-ai/prime-agent`) RLM child and agent-message rules.

An agent tree has one node per agent. The root is the top-level session; each node has:

- a **supervisor** for its children: `spawn`, `list`, `collect` (with an optional timeout that
  returns snapshots instead of failing), `rename`, and `delete` (stops the child and its own
  children; deleting again repeats the receipt);
- **messaging** to its parent, siblings, and children (`sendMessage`, `broadcast`). A running agent
  gets a message steered into its run; a finished child starts work on it; an idle root keeps it in
  its inbox. Messages render as `[agent-message from child:worker]\n\n<text>`;
- an **inbox** of messages that arrived while idle and notices of children that finished or failed;
- **progress notes** (at most 512 characters, one per 10 seconds) shown on the parent's roster.

```ts
import { Agent } from "@generic-ai/agent";
import {
  createAgentChildSessionFactory,
  createSubagentRoot,
  createSubagentTools,
} from "@generic-ai/subagents";

const root = createSubagentRoot({ factory: createAgentChildSessionFactory({ model }) });
const agent = new Agent({
  initialState: { model, systemPrompt: "You lead.", tools: createSubagentTools(root) },
});
const unbind = root.bindAgent(agent); // deliver child messages into the running agent
await agent.prompt("Split the research across two subagents and merge their answers.");
await root.children.shutdown();
unbind();
```

The agent tools are `spawn_agent`, `collect_agents`, `list_agents`, `delete_agent`,
`rename_agent`, `send_agent_message`, `read_inbox`, `observe_agents`, `get_agent`,
`recent_agent_messages`, and (for subagents) `progress_note`.

**Observation** (Prime Agent's `agent_observe`) lets an agent look at its family without
interrupting it. `node.observeAgents()` (tool `observe_agents`) returns the caller's own row as
`current` and its parent, siblings and children as `agents`. Each row has `status` (`running` or
`idle`), the live `activity` (`model`, `tool`, `busy`, `idle`), `messageCount`, `queuedCount`,
`inboxCount`, a subagent's `taskStatus` and `progressNote`, `runningChildren`, and
`messagingPaused`. `node.observeAgent(target)` (tool `get_agent`) returns one row, by id or name;
a name two members share is refused, and anything outside the family is "not reachable".
`node.recentMessages(target, { limit, maxChars })` (tool `recent_agent_messages`) returns previews
of the latest messages with their transcript `index`, `role`, `timestamp`, text (thinking
included), `toolCalls` and `customType`; `limit` is 1-50 (default 8) and `maxChars` 80-2000
(default 800). Transcripts and activity come from `bindAgent` for the root and from the child
session's optional `messages()` and `activity()`; `AgentChildSession` provides both.

**Pausing messages:** `node.pauseMessages()` makes senders get "Agent messaging is paused" until
`node.resumeMessages()`; messages already delivered or waiting stay. `node.clearMessages()` drops
the agent messages waiting in the inbox (child notices stay), and `node.messagingStatus()` reports
the pause flag and limits. These are for the host (for example while a person is typing to that
agent), not agent tools.

Limits (defaults): depth 3, 8 running children per agent, 16,384-character messages, 20 pending
messages per agent, names of at most 64 characters, unique among one parent's live children.

In `@generic-ai/core`, native harness sessions turn this on with `native.subagents`.

Differences from Prime Agent: children run in-process (no daemon, so they do not outlive the
session); `send_agent_message` takes `receiver_role: "all"` for broadcast instead of a positional
`target`; there is no Python kernel surface, decision child, model search, or factory tagging.
