---
"@generic-ai/plugin-delegation": minor
"@generic-ai/plugin-secrets": patch
"@generic-ai/core": patch
---

`createAdapterTaskExecutor` takes a `role` hook that adds per-agent role settings, such as the
secrets an agent may use, to each turn. The secrets broker and lifecycle hooks now wrap frozen
tools (such as the document and web tools) instead of failing with "Cannot redefine property".
