---
"@generic-ai/ai": minor
"@generic-ai/agent": minor
"@generic-ai/tools": minor
"@generic-ai/plugin-tools-files": minor
"@generic-ai/plugin-tools-terminal": minor
"@generic-ai/core": minor
"@generic-ai/sdk": minor
---

Add the native runtime: `@generic-ai/ai` (provider-neutral model layer) and `@generic-ai/agent` (agent loop), `@generic-ai/tools` (read, write, edit, bash, grep, find, and ls), the `native` LLM runtime adapter, and the `native` agent harness adapter, where each role can choose its own `provider/model` through `role.model`. `plugin-tools-files` and `plugin-tools-terminal` now bind the native tools instead of pi's.
