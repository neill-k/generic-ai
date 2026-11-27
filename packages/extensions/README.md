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
  `session_before_compact`, `session_compact`, and the provider and selection events
  `before_provider_request` (return a replacement payload; replacements chain),
  `before_provider_headers` (mutate `event.headers`; `null` removes a header the model or caller
  set), `after_provider_response` (status and headers), `model_select` and
  `thinking_level_select` (fired by `context.setModel` and `context.setThinkingLevel`).
- Chaining: `input` transforms and `before_agent_start` system prompts chain; the first `handled`
  input or `tool_call` block wins; `tool_result` patches chain and keep fields a patch leaves out;
  any handler can cancel compaction.
- A handler that throws is reported to `onError` listeners; the others still run.
- Discovery: `<cwd>/.generic-ai/extensions` and `<agentDir>/extensions`, one level deep: `*.ts` /
  `*.js` files, or directories with an `index` file or a `package.json` listing
  `genericAi.extensions`. TypeScript files load through Node's type stripping.
- Extensions run with the process's permissions. In the harness, discovery is off unless
  `native.extensions.discover` is set, and `native.extensions.projectTrust` keeps an untrusted
  project's own `.generic-ai/extensions` from loading (see project trust in
  `@generic-ai/resources`). `includeProjectExtensions: false` does the same for
  `discoverExtensions`.

## Plan mode

`createPlanMode()` is pi's plan mode without the TUI. While planning, `edit` and `write` are
refused, bash commands must pass a read-only allowlist (`isSafeCommand`: `ls`, `cat`, `rg`,
`git status`… and no redirects, installs or git writes), and the model is asked for a numbered
`Plan:`. When the run ends the steps are extracted (`extractTodoItems`). `execute()` returns the
prompt that starts the plan with full access, and `[DONE:n]` markers (or "all steps complete")
tick steps off until the plan is done.

```ts
import { createPlanMode } from "@generic-ai/extensions";

const planMode = createPlanMode({ enabled: true, onStateChange: save });
// native.extensions: { factories: [planMode.extension] }, or runner.load(planMode.extension)
await run("Plan the migration.");
const next = planMode.execute(); // undefined when the answer had no plan
if (next !== undefined) await run(next);
```

`/plan` toggles plan mode, `/plan on|off` sets it and `/plan execute` starts the latest plan.
`initialState` restores a saved state; `blockedTools` and `bashTools` change which tools are
refused or allowlisted.
