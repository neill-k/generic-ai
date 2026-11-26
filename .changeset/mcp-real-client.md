---
"@generic-ai/plugin-mcp": minor
"@generic-ai/sdk": patch
"@generic-ai/core": patch
---

Make `@generic-ai/plugin-mcp` a real MCP client: connect to stdio, Streamable HTTP and SSE servers from plugin config, reconnect with backoff, and expose server tools to agents as harness tools tagged `mcp.read`/`mcp.write`. Add the `mcp.write` effect to the SDK, let read-only roles call `mcp.read` tools, and have the agent harness add the `mcp` capability's `harnessTools()` to each run's tools.
