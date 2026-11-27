# Native Harness Parity Plan

Status: slices 1 to 9 merged; `pi` is no longer a dependency. Parity is **not complete**: see "Gap audit" below for what pi and Prime Agent still do that the native harness does not.
Owner: the native runtime workstream. Last updated 2026-11-26.

## Goal

Generic AI becomes a complete harness of its own. Today the agent loop, tools, sessions, and most
provider plumbing come from `pi` (`@mariozechner/pi-coding-agent` 0.73.1), with OpenAI Codex as the
only other path. The native runtime replaces that dependency with packages Generic AI owns, behind
the adapter boundary that already exists (`GenericAILlmRuntimeAdapter` in core and
`AgentHarnessAdapter` in the SDK), so the topology scheduler, durable store, and queue work in other
threads can build on it without caring which runtime runs underneath.

Parity targets:

- **pi** (`badlogic/pi-mono`, now published as `@earendil-works/pi-*` 1.6.x): the model layer, the
  agent loop, the coding agent (tools, sessions, compaction, skills, extensions, MCP, RPC), and the
  durable runtime.
- **Prime Agent** (`PrimeIntellect-ai/prime-agent`): the multi-agent and long-running features:
  real subagents, agent-to-agent messaging, daemon sessions, goals, heartbeats and schedules,
  bounded autonomous mode, and the continual harness (`/refine`). Neill confirmed on
  2026-11-26 that this is the project he meant by "prime-agents".

Parity is proven with tests: pi's suites are ported (TypeScript, so most port directly), and Prime
Agent's Rust tests are used as behavioural specifications, since its runtime is Rust and Python.

## Licenses

| Project | License | What it allows |
| --- | --- | --- |
| pi (`badlogic/pi-mono`) | MIT, Copyright (c) 2026 Earendil Inc. | Copy, adapt, and ship code and tests, including commercially, as long as the copyright and permission notice travel with them. Ported files carry a header and each package ships `THIRD_PARTY_NOTICES.md`. |
| Prime Agent | MIT, Copyright (c) 2025-2026 Prime Intellect Ltd. | Same terms. `@generic-ai/subagents` adapts its agent-messaging, progress-note and child-roster rules and tests; ported files carry a header and the package ships `THIRD_PARTY_NOTICES.md`. |

## Architecture

```
@generic-ai/ai      provider-neutral messages, streaming protocol, providers, catalog, faux provider
@generic-ai/agent   agent loop + Agent (tools, hooks, steering/follow-up queues)
@generic-ai/tools   coding tools: read, write, edit, bash, grep, find, ls
@generic-ai/session JSONL session tree, compaction, branch summaries, retry helpers
@generic-ai/core    adapter "native" (createNativeRuntime) beside "pi" and "openai-codex"
```

The two runtime packages are a new bottom layer ("Native runtime" in
`docs/package-boundaries.md`). They depend only on the official provider SDKs and each other, and
the boundary script enforces that they never import core, the SDK, plugins, or presets.

Deliberate differences from pi:

- `stream()` never throws; every failure is a terminal `error` event. pi throws for an unknown API.
- The system prompt and tools are fields of the request context, not transcript system messages
  with tool-loadout deltas. Ported tests that depended on transcript system messages were adapted
  or dropped (listed in the test file headers).
- Transport and retries come from `@anthropic-ai/sdk` and `openai` rather than hand-written SSE.
- Model references are `provider/model-id` strings so config can choose a model per role.
- Commands an agent runs get a clean environment. pi's bash tool passes the server's whole
  environment, so provider keys and database URLs reach every command. The native bash tool
  (`@generic-ai/tools`) builds the environment from an allowlist (`AGENT_COMMAND_ENV_KEYS`:
  paths, home and temp directories, shell, user, locale, terminal) plus the session's
  `GENERIC_AI_*` variables; `inheritProcessEnv: true` opts back into the whole environment, and
  `plugin-tools-terminal` passes its own `inheritProcessEnv` through. Subagents reuse the
  session's tools, so they get the same environment. Extensions run in the server process and are
  trusted code, not agent commands. Any later process the runtime starts for an agent (slice 6
  daemon sessions included) must use `getAgentCommandEnv`. Autonomous quality gates already do:
  `createShellGateRunner` runs them in that environment, where Prime Agent passes its own.

## Feature inventory

Status: ✓ done in this slice · ◐ partial · ○ planned. "Tests" names the suite that proves it.

### Model layer (pi `ai`, 198 test files)

| Feature | Status | Tests |
| --- | --- | --- |
| Message, content-block, usage, and stop-reason types; assistant event protocol | ✓ | ported `event-stream.test.ts` |
| Tolerant streaming JSON and tool-argument parsing with repair | ✓ | ported `json-parse.test.ts` |
| Tool-argument validation with coercion against JSON Schema | ✓ | ported `validation.test.ts` |
| Faux provider (scripted responses, usage estimate, simulated prompt cache, pacing, aborts) | ✓ | ported `faux-provider.test.ts` (one test adapted: unknown API is an error event) |
| Anthropic Messages: streaming, thinking (adaptive and budget), signatures, redacted thinking, tool use, OAuth tokens, cache breakpoints and 1h retention, refusal mapping, cost | ✓ | `providers.test.ts` (recorded SSE through the real SDK) |
| OpenAI Responses: reasoning summaries, encrypted reasoning replay, function calls, prompt cache key and retention | ✓ | `providers.test.ts` |
| OpenAI-compatible Chat Completions (OpenRouter, Groq, xAI, DeepSeek, Ollama): reasoning fields, tool-call deltas, usage | ✓ | `providers.test.ts` |
| Virtual models (a router picks the physical model and reasoning level per request), fallback models (next model when one fails before output), `native.fallbackModels` | ✓ | `virtual-models.test.ts` (pi's routing, credential and unrouted cases; session-selection cases do not apply), `native-agent-harness.test.ts` |
| Hosted provider defaults (Cerebras, Fireworks, Together, Hugging Face, NVIDIA, Baseten, Moonshot, Kimi Coding, Z.ai, Xiaomi, MiniMax, Vercel AI Gateway, Meta) | ✓ | `hosted-providers.test.ts` (resolution and key variables; recorded request per API family) |
| Cross-model transcript transforms, tool-call id normalisation, orphaned tool results | ✓ | `transform-messages.test.ts` |
| Model catalog, `provider/id` refs, overrides | ✓ | `transform-messages.test.ts` |
| Google Gemini and Vertex (thinking level and budget, thought-signature replay, multimodal tool results, tool schema conversion, finish-reason mapping) | ✓ | `@generic-ai/ai` `google.ts` on `@google/genai`; cases from pi `google-*` suites in `google-azure.test.ts` |
| Azure OpenAI Responses (endpoint normalisation, deployment map, API version) | ✓ | `azure-openai.ts`; cases from pi `azure-openai-base-url` and `azure-models` |
| Mistral native (thinking chunks, 9-character tool-call ids, `reasoning_effort` level maps and Magistral `prompt_mode`, prompt-cache key and affinity, cached-token usage, raw stop reasons, SSE split across chunks, retries) | ✓ | `mistral.ts` over `fetch`; cases from pi `mistral-*` suites in `mistral.test.ts` |
| Amazon Bedrock Converse (SigV4 and API-key auth, region and endpoint resolution, Claude adaptive and budget thinking with block binding, signed and encrypted reasoning replay, cache points, grouped tool results, OpenAI and flat reasoning efforts, prefixed exceptions, SDK retries) | ✓ | `bedrock.ts` on `@aws-sdk/client-bedrock-runtime`; cases from pi `bedrock-*` suites in `bedrock.test.ts`, driving the real SDK over replayed event-stream frames |
| Cloudflare Workers AI | ○ | not planned for v1 |
| Credential storage, locked token refresh, OAuth building blocks (PKCE, loopback callback, device code) and OpenRouter sign-in | ✓ | `packages/auth/test` (ports pi `oauth-callback-server`, `oauth-device-code`, `openrouter-oauth`; fake `fetch` and a local callback server only) |
| Subscription sign-ins that reuse another product's OAuth client (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot) | ✓ sign-in and refresh, the ChatGPT Codex backend (`openai-codex-responses`, SSE only; pi's WebSocket transport is not ported) and the GitHub Copilot provider with per-model API routing; `getAuth` carries key, headers and base URL into requests | `packages/auth/test/{anthropic,openai-codex,github-copilot}-oauth.test.ts` (ports pi's tests), `packages/ai/test/subscription-providers.test.ts`, `packages/agent/test/agent-loop.test.ts` (fake `fetch` and stream only) |
| Context-overflow detection, max-token clamping, compact-and-retry on overflow | ✓ | pi `overflow.test.ts` ported whole, `clamp-max-tokens` cases; `runWithRetry` `onContextOverflow`, used by native sessions |
| Cross-provider handoff matrix | ○ | pi `cross-provider-handoff` (needs live keys) |
| Deferred (batch) responses, images API, classifiers | ○ | pi `faux-provider` deferred cases, `images*`, `classifier-*` |

### Agent loop (pi `agent`, 5 test files)

| Feature | Status | Tests |
| --- | --- | --- |
| Loop: stream, execute tools, feed results, stop | ✓ | ported `agent-loop.test.ts` |
| Parallel and sequential tool execution, `terminate`, length-truncated tool calls | ✓ | ported `agent-loop.test.ts` |
| `beforeToolCall` / `afterToolCall`, `finishTurn`, `prepareRequest`, `prepareNextTurn` | ✓ | ported `agent-loop.test.ts` |
| `Agent`: state, subscribers, steering and follow-up queues, abort, `waitForIdle`, continue | ✓ | ported `agent.test.ts` |
| Transcript system messages and tool-loadout deltas | — | intentionally not ported (see differences) |

### Generic AI integration

| Feature | Status | Tests |
| --- | --- | --- |
| `adapter: "native"` in `createGenericAILlmRuntime`, stop-tool loop and single-turn modes, streaming | ✓ | `core/test/runtime/native-runtime.test.ts` |
| Starter example accepts `GENERIC_AI_RUNTIME_ADAPTER=native` | ✓ | existing starter tests |
| Native `AgentHarness` adapter (`harness.adapter: native`): capability tools, skills prompt, role effect policy, lifecycle hooks, `delegate_agent`, canonical events, artifacts | ✓ | `core/src/harness/native-agent-harness.test.ts` |
| Per-role model selection (D3): `role.model` (any `provider/model` ref) overrides `harness.model` per role, on both backends | ✓ | `native-agent-harness.test.ts` |
| Topology runner on the native backend | ✓ | `topology-runner.test.ts` (role sessions on the faux provider) |

### Coding agent (pi `coding-agent`, 379 test files)

| Feature | Status | Tests to port |
| --- | --- | --- |
| Tools: read, write, edit (diff), bash, grep, find, ls, file-mutation queue, output truncation | ✓ | ported `tools`, `edit-tool-legacy-input`, `edit-diff-window`, `grep-operations`, `find-abort-before-spawn`, `file-mutation-queue`, `path-utils`, `truncate-surrogates` in `packages/tools/test` (renderer and bash-executor cases dropped; BMP case adapted) |
| `find` without fd: built-in search with fd's glob rules (no `.gitignore`) | ✓ | `find-fallback.test.ts` |
| Image resize, EXIF orientation and conversion in `read` | ✓ | ported `image-process`, `image-processing` (worker-thread cases dropped: resizing runs in process) and the BMP `tools` case in `packages/tools/test`; uses Photon (WASM) like pi |
| Tool binary downloads | ○ | pi `tools-manager` (Generic AI uses `rg`/`fd` from `PATH`) |
| `plugin-tools-files` and `plugin-tools-terminal` on `@generic-ai/tools` (no pi tools left in either plugin) | ✓ | existing plugin tests |
| Sessions on disk: JSONL tree, branching, labels, resume, tree navigation, migration | ✓ | ported `session-manager/*` (8 suites) in `packages/session/test` |
| Compaction and branch summaries | ✓ | ported `compaction`, `branch-summarization` (system-message case dropped) |
| Auto-compaction before each prompt in the native harness, session files per role (`native.sessionDir`) | ✓ | `packages/session/test/agent-session.test.ts`, `native-agent-harness.test.ts` |
| Retry on transient errors (classifier, backoff, retry loop) | ✓ | ported `@generic-ai/ai` `retry`, `uuid`; `agent-session.test.ts` and `native-agent-harness.test.ts` cover the agent-level retry (pi's `agent-session-retry` drives its `AgentSession` class, which is not ported) |
| Usage totals | ✓ | ported `usage-totals` (provider-reported total flag dropped) |
| Context-overflow recovery (compact then retry the turn) | ✓ | `runWithRetry` `onContextOverflow` (slice 8a) |
| Cache stats, auto-compaction queue, cache warming | ○ | pi `agent-session-auto-compaction-queue`, `cache-stats`, `cache-warmer` |
| Session files through the durable store contract (R6) | ○ | once the store lands, `SessionManager` gains a store-backed writer |
| Skills: discovery, validation, collisions, prompt block, `/skill:name` commands | ✓ | ported `skills` into `@generic-ai/resources`; `plugin-agent-skills` now uses it; `native-agent-harness.test.ts` covers `/skill:` runs |
| Prompt templates: loading, `argument-hint`, `$1` / `$@` / `${@:N}` / defaults, `/name` commands | ✓ | ported `prompt-templates`; `promptTemplates` harness option |
| Project context files (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, ancestor layering, worktree dedup) | ✓ | `@generic-ai/resources` `context-files.test.ts` (pi `resource-loader` context and worktree cases); `native.contextFiles` harness option, off by default with `stopAt` for servers |
| Rest of pi's system prompt builder (stable XML sections, `SYSTEM.md` override, tool rule de-duplication, hidden tools) | ◐ | Generic AI's builder shows tool snippets, guidelines, skills, continual notes and context files; pi `system-prompt*` section layout not ported |
| Extensions: events (`input`, `before_agent_start`, `context`, `tool_call`, `tool_result`, turn/message/agent/session events, `session_before_compact`), tools, commands, discovery and loading | ✓ | `@generic-ai/extensions`: discovery cases adapted from `extensions-discovery`, runner cases from `extensions-runner` and `extensions-input-event`; `native.extensions` harness option |
| Extension UI: widgets, dialogs, keybindings, renderers, flags, editor and autocomplete hooks | — | out of scope: no TUI |
| Extension provider hooks (`before_provider_request`, `before_provider_headers`, `after_provider_response`), `model_select` and `thinking_level_select` with `setModel`/`setThinkingLevel` on the context | ✓ | `packages/extensions/test/runner.test.ts` (recorded Chat Completions through a fake fetch). Not ported: `provider_stream_event` (raw provider events) and `user_bash` (the TUI's `!` prefix) |
| Tool search over deferred tools: BM25 ranker, `tool_search` loads matches for the next call, loaded tools survive resume (`native.toolSearch`) | ✓ | ported `tool-search` (codemode cases dropped) in `packages/tools/test`; `native-session-tool-search.test.ts` |
| MCP client and OAuth | ○ | `mcp-*` (Generic AI already has `plugin-mcp`; port only what it lacks) |
| RPC / print modes | ○ | `rpc*`, `print-mode` |
| Interactive TUI, themes, clipboard, HTML export | — | out of scope: Generic AI's surfaces are the web UI and Hono transport |

### Durable runtime (pi `durable`, 109 test files)

Durable execution is being built in the durable store and queue thread. The native runtime will
plug into it through the adapter boundary rather than porting pi's implementation; pi's durable
tests are used as behavioural specs for that thread.

### Multi-agent and long-running work (Prime Agent)

| Feature | Status | Spec source |
| --- | --- | --- |
| Real subagents: spawn, await, run in background, retain (`rlm.spawn`, `rlm.collect`, `list_subagents`, `delete_subagent`, `rename`) | ✓ | `@generic-ai/subagents`: roster text and collect rules from `rlm_child_model` and `rlm_children` tests; in-process, so children stop with their session; `native.subagents` harness option |
| Agent-to-agent messaging and orchestration (parent, sibling, child; broadcast; capacity guard) | ✓ | `@generic-ai/subagents`: `message_ids_and_validation`, `target_and_capacity_guards`, `message_prompts_and_id_parsing`, `message_host_handler_round_trip` ported |
| Progress notes and the inbox | ✓ | `progress_note_throttles_and_stores` ported; inbox kinds `agent-message`, `child-exited`, `child-failed` |
| Agent observation (`agent_observe`: live activity, recent message previews), messaging pause and resume | ○ | `pa-core` agent_observe tests |
| Daemon-backed sessions that survive disconnects and can be reattached | ◐ | Background sessions: a stored session's due jobs resume it from the SDK durable queue on any worker (`createScheduledSessionService`, ADR 0065). Live reattach to a running turn is not ported. |
| Persistent goals: objective, token budget, continuation, no-progress cap and backoff, pause, resume, complete | ✓ | `@generic-ai/autonomy`: `goals.rs` and `goal_driver/tests.rs` cases ported; `complete_goal` tool instead of `goal.complete()`; in native sessions the goal is an SDK goal spec and `complete_goal` runs `runGoalValidators` (ADR 0063, NOVA: the agent cannot mark its own work done); `native.goal` harness option |
| Heartbeats and schedules | ✓ | `@generic-ai/autonomy`: `cron/mod.rs` and `scheduler.rs` tests ported (schedule parsing, cron in UTC, `/heartbeat` grammar, deferral rules, failure backoff); `cron_add`, `cron_list`, `cron_cancel`, `heartbeat_set`, `heartbeat_manage` tools; `native.schedules` harness option; see `docs/schedules.md` |
| Bounded autonomous mode: limits, quality gates, gate-failure continuation, no rerun on an unchanged worktree | ✓ | `@generic-ai/autonomy`: `autonomous/mod.rs`, `driver.rs` and `gates.rs` tests ported; `native.autonomous` harness option; gate commands become `check` validators of the session's SDK goal; in stop-tool mode a completed stop is checked against them |
| Continual harness: supplemental prompts, memories, skill descriptions, subagent specs updated by `/refine` from evidence, base prompt immutable | ✓ | `@generic-ai/continual`: `refinement/{mod,planner,ranking,executor}.rs` tests ported (state merge, history, proposal parsing and validation, apply and rollback, relevance ranking, prompt digest, planner and review requests); `refine`, `harness_read`, `harness_search` tools and `/refine [--global]`, `/refine rollback <id>`; automatic review after a compaction and every 25 turns; `native.continual` harness option; see `docs/continual-harness.md`. Prime's `factory` kind (state-machine workflows run by its Python kernel) is not ported; skill entries name a shell command or an installed skill instead of a Python callable |
| Persistent Python REPL as the primary tool (RLM) | ○ | evaluate later; Generic AI agents do generic work (D6), so this is a plugin, not the core loop |

## Gap audit (2026-11-26, after pi was removed)

Checked against pi-mono at `e73029b` (2026-11-26) and Prime Agent `main`. Everything not listed
here, and not marked ✓ above, is either out of scope (terminal UI and its themes, keybindings,
clipboard and HTML export; Windows PowerShell configuration; pi's package manager and self-update)
or covered by Generic AI's own packages. The borrowed subscription sign-ins were ported after Neill
chose to follow pi; tool search and the hosted provider defaults were closed after this audit.

pi (`badlogic/pi-mono`):

| Gap | Where in pi | Notes |
| --- | --- | --- |
| Remaining built-in providers: Qwen token plans, Cloudflare AI Gateway and Workers AI, OpenCode, and pi's per-model compat quirks and model catalogs for the hosted providers | `ai/src/providers/*` | Cerebras, Fireworks, Together, Hugging Face, NVIDIA, Baseten, Moonshot, Kimi Coding, Z.ai, Xiaomi, MiniMax, Vercel AI Gateway and Meta now have defaults (base URL, API, key variable), 27 providers in all; their models resolve with conservative defaults rather than pi's per-model catalog |
| Image generation API, classifiers, deferred (batch) responses | `ai/src/images*`, `model-runtime-classifiers` | |
| Code mode: model-written JavaScript in a QuickJS sandbox that calls tools, so nested tool results never enter the context | `codemode`, `coding-agent` `codemode-*`, `nested-tool-calls` | Closest to NOVA's "move work out of the model"; also Prime Agent's programmatic tool calling |
| Plan mode, project trust decisions for repository resources | `plan-mode-extension`, `trust-manager` | |
| RPC and print modes (a JSONL protocol to drive an agent from another process) | `rpc*`, `print-mode` | Generic AI's surfaces are the Hono transport and the web UI |
| Durable harness: every turn and tool call committed before it is shown, resumed after a crash mid-turn; remote execution environments over SSH | `durable` (107 test files), `env` | Generic AI has a durable run store, queue and effect journal, but not pi's turn-level commit-and-resume |
| Standalone MCP client with OAuth refresh and the MCP conformance suite | `mcp`, `mcp-conformance`, `mcp-oauth-*` | `plugin-mcp` uses the official SDK; OAuth for remote servers is not covered |
| Tool binary downloads (`rg`, `fd` fetched on first use) | `tools-manager` | Deploy images install them; a local user needs them on `PATH` |
| Telemetry contracts (spans, metrics, propagation) | `telemetry` | Generic AI has `@generic-ai/observability` with its own shape |
| Chord (reloadable multi-process object runtime) and the evals harness | `chord`, `evals` | Application framework and pi's own evals, not harness features |

Prime Agent:

| Gap | Where | Notes |
| --- | --- | --- |
| Persistent Python REPL as the main tool, prompt-as-a-variable, programmatic subagent calls, executable Python skills | `pa-core` RLM, `pa-agent` | Code mode would cover the programmatic tool calling in JavaScript |
| `agent_observe` (live activity and recent messages of another agent), messaging pause and resume | `pa-daemon` `agent_messaging/observe.rs` | |
| Live reattach to a running turn after a disconnect | `pa-daemon` | Background sessions resume from the durable queue instead |
| Factory workflows (state-machine skills run by the Python kernel) | `pa-factory` | |

## Slices

Each slice is a reviewable PR that keeps every existing test green.

1. **Model layer and agent loop** (this PR): `@generic-ai/ai`, `@generic-ai/agent`, native adapter.
2. **Native harness adapter and per-role models** (in review): core's `AgentHarness` runs on the
   native loop through a `HarnessSessionBackend`, sharing policy, hooks, delegation, events and
   artifacts with the pi backend.
2b. **Native coding tools** (in review with slice 2): `@generic-ai/tools` ports read, write, edit,
   bash, grep, find and ls with pi's tool tests, and `plugin-tools-files` and
   `plugin-tools-terminal` now bind them, so both adapters run the native tools.
3. **Sessions, compaction, retry** (in review): `@generic-ai/session` ports pi's JSONL session
   manager, compaction and branch summaries; `@generic-ai/ai` gains the retry classifier and
   backoff. The native harness records sessions (in memory, or as files under `native.sessionDir`),
   compacts before a prompt that would overflow, and retries transient provider errors.
4. **Skills, prompt templates, extensions**: 4a (in review) adds `@generic-ai/resources` with pi's
   skill loader and prompt templates, moves `plugin-agent-skills` onto it, and expands
   `/skill:name` and `/template` instructions in harness runs on both backends. 4b (in review)
   adds `@generic-ai/extensions` and loads extensions into native sessions (`native.extensions`).
5. **Subagents and messaging** (in review): `@generic-ai/subagents` with Prime Agent's spawn,
   collect, delete and rename rules, family messaging, inbox and progress notes, turned on in
   native harness sessions with `native.subagents`.
6. **Long-running agents**: 6a (in review) adds `@generic-ai/autonomy` with Prime Agent's thread
   goals and autonomous mode and turns them on in native sessions (`native.goal`,
   `native.autonomous`). 6b (in review) adds schedules and heartbeats (`native.schedules`) and background sessions that resume from the durable queue (ADR 0065).
7. **Continual harness** (in review): `@generic-ai/continual` ports Prime Agent's `/refine`: a
   global and a session-local store of prompt notes, memories, skills and subagent specs that the
   agent refines from evidence, with history and rollback, shown in the system prompt ranked by
   relevance (`native.continual`, ADR 0067).
8. **More providers and auth**: 8a adds Google Gemini, Vertex AI and Azure OpenAI, and
   context-overflow detection with compact-and-retry; 8b Bedrock and native Mistral; 8c
   `@generic-ai/auth`: credential stores, locked token refresh, the OAuth building blocks and
   OpenRouter's sign-in. Sign-ins that reuse another product's OAuth client were ported after Neill chose to follow pi (2026-11-26).
9. **Make native the default and remove pi**: 9a makes `native` the default harness
   and LLM runtime adapter (ADR 0068); 9b moves the plugin tool API off
   `@generic-ai/sdk/pi` to `defineTool` in the root `@generic-ai/sdk`; 9c (in review)
   removes the `pi` and `openai-codex` adapters, the `@generic-ai/sdk/pi` subpath and
   the `pi` dependencies, ports the harness tests to the native runtime with the faux
   provider, and rewrites the starter's live smoke on a native session.

## Running the parity suites

```bash
npx vitest run packages/ai packages/agent packages/tools packages/session packages/resources packages/extensions packages/subagents packages/autonomy packages/continual packages/auth packages/core/test/runtime/native-runtime.test.ts packages/core/src/harness/native-agent-harness.test.ts packages/core/src/runtime/native-session-long-run.test.ts
```
