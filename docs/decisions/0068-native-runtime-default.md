# 0068 — The native runtime is the default

- Status: accepted
- Date: 2026-11-26
- Amended: 2026-11-26 (slice 9c: `pi` removed)
- Supersedes: `0011-pi-direct-boundary.md`
- Related: `docs/planning/native-harness-parity.md` (slice 9), `docs/generic-ai-and-pi.md`

## Context

Generic AI has run on `pi` since the first vertical slice. Slices 1 to 8 built a native runtime
with feature parity: the model layer and providers, the agent loop, tools, sessions and compaction,
resources, extensions, subagents, long-running work, the continual harness, offloading and
credentials. Generic Corp already runs every role on the native adapter. Neill asked for a full
harness of Generic AI's own, without `pi` underneath.

## Decision

1. A harness config without `adapter` runs on `native` (`DEFAULT_AGENT_HARNESS_ADAPTER` in
   `@generic-ai/sdk`). Topology runs follow the same default.
2. `createGenericAILlmRuntime` without `adapter` uses `native`
   (`DEFAULT_GENERIC_AI_RUNTIME_ADAPTER`). The default model stays `gpt-5.5`, which the native
   adapter resolves to OpenAI.
3. Web UI templates and the starter example's harness write `adapter: native`.
4. `pi` and `openai-codex` were removed in two later steps: first the plugin tool API moved off
   `@generic-ai/sdk/pi` to a runtime-neutral one (`defineTool` in `@generic-ai/sdk`, slice 9b), then
   the `pi` adapter, the `openai-codex` adapter, the `@generic-ai/sdk/pi` subpath and the `pi`
   dependencies were deleted (slice 9c).

## Consequences

- New projects and configs that never named an adapter run on the native runtime, with provider
  keys from `GENERIC_AI_PROVIDER_API_KEY` or the provider's own environment variable. Pi's stored
  `openai-codex` sign-in is no longer used.
- `adapter: pi` and `adapter: openai-codex` are rejected by config validation and by
  `createGenericAILlmRuntime`. The harness adapter kinds are `native` and `external`.
- `DEFAULT_OPENAI_CODEX_MODEL` remains as a deprecated alias of `DEFAULT_GENERIC_AI_MODEL`.
- The three production audit advisories that came only through `pi` are gone, and
  `security/audit-allowlist.json` is empty.
- Borrowed subscription sign-ins (ChatGPT/Codex, Claude Pro/Max, Copilot) are not ported; providers
  use API keys or the credential store in `@generic-ai/auth`.
