---
"@generic-ai/sdk": minor
"@generic-ai/core": patch
"@generic-ai/plugin-interaction": patch
"@generic-ai/plugin-lsp": patch
"@generic-ai/plugin-repo-map": patch
"@generic-ai/plugin-web-ui": patch
---

Add the runtime-neutral agent tool contract to the root of `@generic-ai/sdk`: `defineTool`, `ToolDefinition`, `AgentToolResult`, `AgentToolUpdateCallback` and `ToolExecutionMode`. Core and the interaction, LSP, repo-map and web UI plugins now define their tools with it instead of `@generic-ai/sdk/pi`, which is deprecated and goes away with the `pi` adapter.
