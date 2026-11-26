# @generic-ai/extensions

Extensions for the Generic AI native runtime, following pi's coding-agent extension model (MIT;
see `THIRD_PARTY_NOTICES.md`) without its terminal UI.

```ts
// .generic-ai/extensions/audit.ts
import type { ExtensionAPI } from "@generic-ai/extensions";

export default function (api: ExtensionAPI) {
  api.on("tool_call", (event) =>
    event.toolName === "bash" && String((event.input as { command?: string }).command).includes("rm -rf")
      ? { block: true, reason: "Destructive commands need approval." }
      : undefined,
  );
  api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nCite sources.` }));
  api.registerCommand("status", { handler: async (_args, ctx) => console.log(ctx.getMessages().length) });
}
```

```ts
import { discoverAndLoadExtensions } from "@generic-ai/extensions";

const { runner, errors } = await discoverAndLoadExtensions({ cwd, agentDir });
const unbind = runner.bindAgent(agent); // adds tools, routes context/tool hooks, forwards events
await runner.runPrompt("/status", (text) => agent.prompt(text));
```

- Events: `session_start`, `session_shutdown`, `input`, `before_agent_start`, `agent_start`,
  `agent_end`, `turn_start`, `turn_end`, `message_end`, `context`, `tool_call`, `tool_result`,
  `session_before_compact`, `session_compact`.
- Chaining: `input` transforms and `before_agent_start` system prompts chain; the first `handled`
  input or `tool_call` block wins; `tool_result` patches chain and keep fields a patch leaves out;
  any handler can cancel compaction.
- A handler that throws is reported to `onError` listeners; the others still run.
- Discovery: `<cwd>/.generic-ai/extensions` and `<agentDir>/extensions`, one level deep: `*.ts` /
  `*.js` files, or directories with an `index` file or a `package.json` listing
  `genericAi.extensions`. TypeScript files load through Node's type stripping.
- Extensions run with the process's permissions. In the harness, discovery is off unless
  `native.extensions.discover` is set.
