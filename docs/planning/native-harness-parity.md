# Native Harness Parity Plan

Status: slice 1 landed for review (model layer, agent loop, native adapter). Owner: the native
runtime workstream. Last updated 2026-11-26.

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
  bounded autonomous mode, and the continual harness (`/refine`). This is the best match for
  "prime-agents"; there is no other public project by that name with a harness.

Parity is proven with tests: pi's suites are ported (TypeScript, so most port directly), and Prime
Agent's Rust tests are used as behavioural specifications, since its runtime is Rust and Python.

## Licenses

| Project | License | What it allows |
| --- | --- | --- |
| pi (`badlogic/pi-mono`) | MIT, Copyright (c) 2026 Earendil Inc. | Copy, adapt, and ship code and tests, including commercially, as long as the copyright and permission notice travel with them. Ported files carry a header and each package ships `THIRD_PARTY_NOTICES.md`. |
| Prime Agent | MIT, Copyright (c) 2025-2026 Prime Intellect Ltd. | Same terms. Nothing from it is copied yet; when code or test fixtures are adapted, the notice is added the same way. |

## Architecture

```
@generic-ai/ai      provider-neutral messages, streaming protocol, providers, catalog, faux provider
@generic-ai/agent   agent loop + Agent (tools, hooks, steering/follow-up queues)
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
| Native `AgentHarness` adapter (capability tools, skills, effects policy) replacing the pi session | ○ | `core/src/harness/agent-harness.test.ts` run against both adapters |
| Per-role model selection in config (D3) | ○ | config schema tests |

### Coding agent (pi `coding-agent`, 379 test files)

| Feature | Status | Tests to port |
| --- | --- | --- |
| Tools: read, write, edit (diff), bash, grep, find, ls, file-mutation queue, output truncation | ○ | `tools`, `edit-*`, `bash-*`, `grep-operations`, `find-*`, `file-mutation-queue`, `truncate-*` |
| Sessions on disk: JSONL tree, branching, resume, tree navigation | ○ | `session-manager`, `agent-session-branching`, `agent-session-tree-navigation` |
| Compaction and branch summaries, auto-compaction queue | ○ | `compaction*`, `branch-summarization`, `agent-session-compaction`, `agent-session-auto-compaction-queue` |
| Retry on transient errors, usage totals, cache stats | ○ | `agent-session-retry`, `usage-totals`, `cache-stats` |
| Skills, prompt templates, system prompt assembly | ○ | `skills`, `sdk-skills`, `prompt-templates`, `system-prompt*` |
| Extensions and event bus | ○ | `extensions-*` |
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
| Real subagents: spawn, await, run in background, retain (`rlm.spawn`) | ○ | `pa-agent` subagent tests |
| Agent-to-agent messaging and orchestration | ○ | `pa-daemon` messaging tests |
| Daemon-backed sessions that survive disconnects and can be reattached | ○ | `pa-daemon` |
| Persistent goals (`/goal`), heartbeats, schedules | ○ | `pa-core` goal/schedule tests |
| Bounded autonomous mode | ○ | `pa-core` autonomy tests |
| Continual harness: supplemental prompts, memories, skill descriptions, subagent specs updated by `/refine` from evidence, base prompt immutable | ○ | `pa-core` refine tests, Continual Harness paper |
| Persistent Python REPL as the primary tool (RLM) | ○ | evaluate later; Generic AI agents do generic work (D6), so this is a plugin, not the core loop |

## Slices

Each slice is a reviewable PR that keeps every existing test green.

1. **Model layer and agent loop** (this PR): `@generic-ai/ai`, `@generic-ai/agent`, native adapter.
2. **Native tools and harness adapter**: port the coding tools, run core's `AgentHarness` on the
   native loop with capability tools and effect policy, add per-role models to config.
3. **Sessions, compaction, retry**: on-disk sessions through the durable store contract,
   compaction and summaries, transient-error retry.
4. **Skills, prompt templates, extensions**: reuse `plugin-agent-skills`; port pi's extension hooks
   that Generic AI lacks.
5. **Subagents and messaging**: native subagent spawning and agent-to-agent messages, wired to the
   topology scheduler.
6. **Long-running agents**: daemon sessions, goals, heartbeats and schedules, autonomous mode, on
   the durable queue.
7. **Continual harness**: evidence-backed refinement of supplemental harness state.
8. **More providers and auth**: Gemini, Bedrock, Azure, OAuth logins.
9. **Make native the default and remove pi**: once the harness suite passes on the native adapter.

## Running the parity suites

```bash
npx vitest run packages/ai packages/agent packages/core/test/runtime/native-runtime.test.ts
```
