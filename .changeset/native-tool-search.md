---
"@generic-ai/tools": minor
"@generic-ai/core": minor
---

Add tool search over deferred tools, ported from pi: `createToolSearchTool` and the BM25 ranker in `@generic-ai/tools`, and `toolSearch` on native sessions and `native.toolSearch` on the harness, which defers MCP tools behind `tool_search` and keeps the tools it loaded when a session resumes.
