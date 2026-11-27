# @generic-ai/session

Sessions for the Generic AI native runtime, adapted from pi's coding agent (MIT; see
`THIRD_PARTY_NOTICES.md`).

```ts
import { Agent } from "@generic-ai/agent";
import {
  compactIfNeeded,
  convertToLlm,
  persistAgentMessages,
  restoreAgentContext,
  runWithRetry,
  SessionManager,
} from "@generic-ai/session";

const session = SessionManager.create(cwd, sessionDir); // or SessionManager.open(file) to resume
const agent = new Agent({ initialState: { model, systemPrompt }, convertToLlm });
restoreAgentContext(agent, session);
persistAgentMessages(agent, session);

await compactIfNeeded(agent, session, { model });
await runWithRetry(agent, () => agent.prompt("Continue the migration"));
```

- `SessionManager` keeps an append-only JSONL tree: messages, model and thinking-level changes,
  labels, custom entries, compactions, and branch summaries. It can branch from any entry, move the
  leaf, list and resume sessions, fork into a new file, and migrate older file versions.
- `prepareCompaction` / `compact` summarise the older part of a branch with the model and keep the
  recent turns; `generateBranchSummary` summarises a branch the session moves away from.
- `compactIfNeeded` compacts when the context is within `reserveTokens` of the model's window and
  reloads the agent from the session.
- `runWithRetry` retries a step while it ends in a transient provider error (overloaded, rate limit,
  5xx, dropped connection) with exponential backoff. Quota and billing errors fail at once.
- Session files live under `GENERIC_AI_AGENT_DIR` (default `~/.generic-ai/agent/sessions`) unless a
  directory is passed.

## Print and RPC modes

Two ways to drive a session from another program, ported from pi:

```ts
import { runPrintMode, runRpcMode, RpcClient } from "@generic-ai/session";

// One-shot: write the final answer (or every event as JSON lines) and get an exit code.
const code = await runPrintMode({ agent, sessionManager }, { mode: "text", initialMessage: "Fix the build" });

// Long-lived: serve JSON-line commands on stdin and write responses and agent events to stdout.
await runRpcMode({ agent, sessionManager, prompt: (text, images) => myPipeline(text, images) });

// The other side: a typed client over a child process or any pair of streams.
const client = await RpcClient.spawn({ command: "node", args: ["my-agent.js"] });
await client.promptAndWait("Summarise the open issues");
console.log(await client.getLastAssistantText());
```

- The framing is strict JSONL: records split on `\n` only, so U+2028 and U+2029 inside strings are
  safe. Responses are `{ id?, type: "response", command, success, data | error }`; everything else
  on the stream is an agent event, or `prompt_error` when the host's prompt pipeline throws after a
  prompt has started.
- A `prompt` while the agent is working must say `streamingBehavior: "steer"` or `"followUp"`;
  without it the command fails. `clear_queue` returns the texts that were still waiting.
- Commands: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`,
  `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`,
  `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`,
  `set_follow_up_mode`, `compact`, `set_auto_compaction`, `get_session_stats`, `get_entries`,
  `get_last_assistant_text`, `set_session_name`, `get_messages`, `get_commands`. pi's bash, fork,
  tree, clone and HTML export commands are not served.
- The host (`AgentModeHost`) supplies the agent and, optionally, the session manager, its own
  prompt pipeline (extensions, retry), model lookup and list, compaction settings, the commands
  `get_commands` lists, and a `dispose` hook. There is no CLI binary; wire these modes to your own
  entry point.
