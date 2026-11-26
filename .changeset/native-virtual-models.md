---
"@generic-ai/ai": minor
"@generic-ai/core": minor
---

Add virtual models (`registerVirtualModel`: a router picks the physical model per request) and fallback models (`createFallbackModel`), ported from pi, and `native.fallbackModels` on the harness, which moves a role to the next model when its model fails before producing output.
