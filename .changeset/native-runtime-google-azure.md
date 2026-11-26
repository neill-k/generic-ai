---
"@generic-ai/ai": minor
"@generic-ai/session": minor
"@generic-ai/core": minor
---

Add Google Gemini (`google/...`), Vertex AI (`google-vertex/...`) and Azure OpenAI (`azure-openai/...`) providers to the native model layer, and context-overflow handling: `isContextOverflow` recognises every supported provider's overflow errors, `clampMaxTokensToContext` fits an output budget into the window, and native sessions compact and retry once when a turn overflows (`runWithRetry`'s `onContextOverflow`).
