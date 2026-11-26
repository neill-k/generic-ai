---
"@generic-ai/sdk": minor
"@generic-ai/core": minor
"@generic-ai/plugin-web-ui": minor
---

The native runtime is now the default. Harness configs without `adapter` run on `native` (new `DEFAULT_AGENT_HARNESS_ADAPTER`), `createGenericAILlmRuntime` defaults to `native`, and web UI templates write `adapter: native`. Name `pi` or `openai-codex` explicitly to keep the old behavior until those adapters are removed.
