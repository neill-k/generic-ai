---
"@generic-ai/sdk": minor
"@generic-ai/core": minor
---

Remove `pi`. The `pi` and `openai-codex` runtime adapters, `createCapabilityPiAgentSession`/`runCapabilityPiAgentSession`, `createOpenAICodexRuntime`, the `@generic-ai/sdk/pi` subpath and the `@mariozechner/pi-coding-agent` dependency are gone. Agent sessions run on the native runtime only; harness adapter kinds are `native` and `external`, and config validation rejects `adapter: pi`. Define tools with `defineTool` from `@generic-ai/sdk`. `DEFAULT_OPENAI_CODEX_MODEL` remains as a deprecated alias of the new `DEFAULT_GENERIC_AI_MODEL`, and the bootstrap's `piBoundary` field is now `runtimeBoundary`.
