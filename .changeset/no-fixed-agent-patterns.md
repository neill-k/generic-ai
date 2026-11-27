---
"@generic-ai/sdk": minor
"@generic-ai/core": minor
"@generic-ai/plugin-approvals": minor
"@generic-ai/plugin-delegation": minor
"@generic-ai/plugin-web-ui": minor
"@generic-ai/observability": patch
---

Remove fixed agent patterns (ADR 0071). The pipeline, verifier-loop, hierarchy and squad protocols, the topology runner and executors, `runAgentHarnessTopology`, `runHarnessBenchmark`, the topology approver and the Harness DSL `protocols` section are gone, and role kinds are `root`, `builder` and `custom`. Every role, the harness's primary agent included, is a full agent with the tools its policy allows; `readOnly` is the only role restriction. `parseActorDirectives` moves to `harness/directives.ts`, and the `protocol.action.planned` trace event is now `handoff.recorded`.
