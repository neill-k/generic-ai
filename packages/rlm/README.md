# @generic-ai/rlm

A persistent Python workspace for Generic AI agents, borrowed from Prime Agent's RLM (recursive
language model) working style. The agent gets one `python` tool. Everything it runs shares one
interpreter for the whole session, so:

- Large inputs live in variables, not in the conversation. The agent loads a file or a tool result,
  slices it in code and prints only what it needs. Output beyond the limit (20,000 characters by
  default) is cut, keeping the head and tail.
- Code can call smaller models: `await rlm.llm(prompt, model=None, system=None, max_tokens=None)`
  returns one answer, and `await rlm.llm_batch(prompts, ...)` asks many in parallel. Map over chunks,
  then combine the answers in code.
- Code can call the agent's other tools: `await rlm.tool(name, **args)` returns a result with
  `.text`, `.details` and `.is_error` that stays in the workspace unless printed.
- `await rlm.models()`, `await rlm.tools()` and `await rlm.messages(start=-10, limit=10, role="*")`
  list the models, the tools and the conversation as data.

```ts
import { createRlmWorkspace } from "@generic-ai/rlm";

const workspace = createRlmWorkspace({
  cwd,
  variables: { report: hugeText },                 // available as `report` in Python
  llm: { model: smallModel, resolveModel, getApiKey },
  tools: () => agentTools,                         // callable with rlm.tool
  getMessages: () => agent.state.messages,
  snapshotPath: join(sessionDir, "workspace.pkl"), // variables survive a restart
});
agent.state.tools = [...agentTools, workspace.tool];
// ...
await workspace.dispose();
```

In a native session, set `rlm: true` (or options) on `runCapabilityNativeAgentSession`, or `rlm` in
the native harness options, where `model` names the default sub-model (`"provider/id"`).

## Behaviour

- The kernel (`python/kernel.py`) speaks newline-delimited JSON over stdio, following Prime Agent's
  REPL protocol: cells run with top-level `await` on one event loop, so background tasks keep running
  between calls; the value of a trailing expression is shown as `Out: ...`; tracebacks show the
  cell's own source lines; `sys.exit` is refused rather than ending the kernel.
- Each call has a timeout (120 seconds by default, at most 600). A cell past it, or whose tool call
  is aborted, is interrupted with `KeyboardInterrupt` and the variables stay. A cell that ignores the
  interrupt for 3 seconds gets the kernel restarted, and the model is told its variables are gone.
- Calls run one at a time, even when the model calls the tool in parallel.
- `snapshotPath` pickles the variables when the workspace is disposed and loads them when it next
  starts; values that cannot be pickled (functions, open files) are skipped.
- The kernel gets the clean agent-command environment (`getAgentCommandEnv`), not the server's
  secrets. Use `launch` to run it as another OS user, as Generic Corp does for agent commands.
- Sub-model calls are capped per tool call (200 by default) and run at most 8 at a time. Each
  finished response goes to `llm.onResponse`, which native sessions use for usage metering.

Needs Python 3.9 or later on the host (`python3`, or `GENERIC_AI_PYTHON`).
