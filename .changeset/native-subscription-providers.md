---
"@generic-ai/ai": minor
"@generic-ai/agent": minor
"@generic-ai/auth": minor
"@generic-ai/core": minor
---

Run models on the subscription sign-ins: the ChatGPT Codex backend (`openai-codex/<model>`, `openai-codex-responses`) and GitHub Copilot (`github-copilot/<model>`, routed per model to Messages, Responses or Chat Completions). Adds `getAuth` to the agent loop and `Agent`, `native.getAuth` to the core harness, and `createModelAuthResolver` to `@generic-ai/auth`, so a sign-in's headers and base URL reach each request.
