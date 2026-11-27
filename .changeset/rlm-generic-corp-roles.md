---
"@generic-ai/plugin-tools-terminal": minor
"@generic-ai/core": minor
---

Add `wrapProcessForUser` and a `keepStdin` option on `wrapCommandForUser`, so a long-lived process such as the Python workspace kernel runs as the agent user with the same limits and keeps its stdin.

The native harness `rlm` option takes `agentEnv(agentId)` for per-agent kernel environment (for example proxy settings), and the `python` tool carries the same effect tags as the shell tool.
