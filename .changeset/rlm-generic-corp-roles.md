---
"@generic-ai/plugin-tools-terminal": minor
---

Add `wrapProcessForUser` and a `keepStdin` option on `wrapCommandForUser`, so a long-lived process such as the Python workspace kernel runs as the agent user with the same limits and keeps its stdin.
