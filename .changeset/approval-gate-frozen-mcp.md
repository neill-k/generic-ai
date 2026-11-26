---
"@generic-ai/plugin-approvals": patch
---

`wrapBindings` now works with the frozen MCP capability that `@generic-ai/plugin-mcp` returns. The gate wrapped it in a proxy over the capability itself, and a proxy over a frozen object may not return a different `harnessTools`, so any company with MCP servers configured failed every agent turn. The proxy now sits over an empty shim and forwards everything else to the capability.
