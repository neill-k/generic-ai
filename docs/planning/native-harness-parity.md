# Native Harness Parity Plan

Status: slice 1 merged (model layer, agent loop, native LLM adapter); slice 2 in review (native harness adapter, per-role models, native coding tools); slice 3 in review (sessions, compaction, retry).
Owner: the native runtime workstream. Last updated 2026-11-26.

## Goal

Generic AI becomes a complete harness of its own. Today the agent loop, tools, sessions, and most
provider plumbing come from `pi` (`@mariozechner/pi-coding-agent` 0.70.6), with OpenAI Codex as the
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
| OpenAI-compatible Chat Completions (OpenRouter, Groq, xAI, DeepSeek, Mistral, Ollama): reasoning fields, tool-call deltas, usage | ✓ | `providers.test.ts` |
| Cross-model transcript transforms, tool-call id normalisation, orphaned tool results | ✓ | `transform-messages.test.ts` |
| Model catalog, `provider/id` refs, overrides | ✓ | `transform-messages.test.ts` |
| Google Gemini / Vertex, Bedrock, Azure OpenAI, Mistral native, Cloudflare | ○ | pi `google-*`, `bedrock-*`, `azure-*`, `mistral-*` suites |
| OAuth login flows (Claude, ChatGPT, Copilot) and credential storage | ○ | pi `oauth*`, `*-oauth.test.ts` |
| Context-overflow detection, max-token clamping, cross-provider handoff matrix | ○ | pi `context-overflow`, `clamp-max-tokens`, `cross-provider-handoff` |
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
| Topology runner (PR 107) on the native backend | ○ | once PR 107 lands, its `runRoleSession` calls `HarnessSessionBackend.run` |

### Coding agent (pi `coding-agent`, 379 test files)

| Feature | Status | Tests to port |
| --- | --- | --- |
| Tools: read, write, edit (diff), bash, grep, find, ls, file-mutation queue, output truncation | ✓ | ported `tools`, `edit-tool-legacy-input`, `edit-diff-window`, `grep-operations`, `find-abort-before-spawn`, `file-mutation-queue`, `path-utils`, `truncate-surrogates` in `packages/tools/test` (renderer and bash-executor cases dropped; BMP case adapted) |
| `find` without fd: built-in search with fd's glob rules (no `.gitignore`) | ✓ | `find-fallback.test.ts` |
| Image resize and conversion in `read`, tool binary downloads | ○ | pi `read-*`, `tools-manager` (Generic AI attaches PNG/JPEG/GIF/WebP as-is and uses `rg`/`fd` from `PATH`) |
| `plugin-tools-files` and `plugin-tools-terminal` on `@generic-ai/tools` (no pi tools left in either plugin) | ✓ | existing plugin tests |
| Sessions on disk: JSONL tree, branching, labels, resume, tree navigation, migration | ✓ | ported `session-manager/*` (8 suites) in `packages/session/test` |
| Compaction and branch summaries | ✓ | ported `compaction`, `branch-summarization` (system-message case dropped) |
| Auto-compaction before each prompt in the native harness, session files per role (`native.sessionDir`) | ✓ | `packages/session/test/agent-session.test.ts`, `native-agent-harness.test.ts` |
| Retry on transient errors (classifier, backoff, retry loop) | ✓ | ported `@generic-ai/ai` `retry`, `uuid`; `agent-session.test.ts` and `native-agent-harness.test.ts` cover the agent-level retry (pi's `agent-session-retry` drives its `AgentSession` class, which is not ported) |
| Usage totals | ✓ | ported `usage-totals` (provider-reported total flag dropped) |
| Context-overflow recovery (compact then retry the turn), cache stats, auto-compaction queue | ○ | pi `agent-session-auto-compaction-queue`, `cache-stats`, `context-overflow` |
| Session files through the durable store contract (R6) | ○ | once the store lands, `SessionManager` gains a store-backed writer |
| Skills: discovery, validation, collisions, prompt block, `/skill:name` commands | ✓ | ported `skills` into `@generic-ai/resources`; `plugin-agent-skills` now uses it; `native-agent-harness.test.ts` covers `/skill:` runs |
| Prompt templates: loading, `argument-hint`, `$1` / `$@` / `${@:N}` / defaults, `/name` commands | ✓ | ported `prompt-templates`; `promptTemplates` harness option |
| System prompt assembly (pi's full builder, context files such as `AGENTS.md`) | ○ | `system-prompt*` |
| Extensions: events (`input`, `before_agent_start`, `context`, `tool_call`, `tool_result`, turn/message/agent/session events, `session_before_compact`), tools, commands, discovery and loading | ✓ | `@generic-ai/extensions`: discovery cases adapted from `extensions-discovery`, runner cases from `extensions-runner` and `extensions-input-event`; `native.extensions` harness option |
| Extension UI: widgets, dialogs, keybindings, renderers, flags, editor and autocomplete hooks | — | out of scope: no TUI |
| Extension provider hooks (`before_provider_request`, headers, stream events), model/thinking selection events, user bash | ○ | `extensions-runner` provider cases |
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
| Daemon-backed sessions that survive disconnects and can be reattached | ○ | `pa-daemon` |
| Persistent goals (`/goal`), heartbeats, schedules | ○ | `pa-core` goal/schedule tests |
| Bounded autonomous mode | ○ | `pa-core` autonomy tests |
| Continual harness: supplemental prompts, memories, skill descriptions, subagent specs updated by `/refine` from evidence, base prompt immutable | ○ | `pa-core` refine tests, Continual Harness paper |
| Persistent Python REPL as the primary tool (RLM) | ○ | evaluate later; Generic AI agents do generic work (D6), so this is a plugin, not the core loop |

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
6. **Long-running agents**: daemon sessions, goals, heartbeats and schedules, autonomous mode, on
   the durable queue.
7. **Continual harness**: evidence-backed refinement of supplemental harness state.
8. **More providers and auth**: Gemini, Bedrock, Azure, OAuth logins.
9. **Make native the default and remove pi**: once the harness suite passes on the native adapter.

## Running the parity suites

```bash
npx vitest run packages/ai packages/agent packages/tools packages/session packages/resources packages/extensions packages/subagents packages/core/test/runtime/native-runtime.test.ts packages/core/src/harness/native-agent-harness.test.ts
```
