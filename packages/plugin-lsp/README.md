# @generic-ai/plugin-lsp

Configurable Language Server Protocol tools for Generic AI harness runs.

The plugin exposes one Pi-compatible `lsp` tool with `servers`, `diagnostics`, `document-symbols`, `definition`, and `references` actions. It can use an injected client for tests or `createStdioLspClient()` for stdio language servers.

The tool declares `lsp.read`, `fs.read`, and `process.spawn` effects for `AgentHarness` role-policy filtering. Benchmark profiles should omit or gate it unless spawning language servers is explicitly allowed.
