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
