---
"@generic-ai/sdk": patch
"@generic-ai/core": patch
---

Meter native context compaction: the summary call's usage is recorded as a `usage.recorded` event with `purpose: "compaction"` and counts toward run budgets, so a budget reached by compaction stops the session before its next model call.
