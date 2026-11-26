---
"@generic-ai/ai": minor
---

Add the native Mistral API (`mistral-conversations`), now the default for `mistral/...` models: thinking chunks, Mistral's 9-character tool-call ids, `reasoning_effort` through a model's new `thinkingLevelMap` (or `prompt_mode` for Magistral), prompt-cache key and `x-affinity` from the session id, and cached-token usage. Adds `SseDecoder`/`readSseEvents` and `fetchWithRetry` for providers that stream over plain `fetch`.
