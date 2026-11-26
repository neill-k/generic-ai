---
"@generic-ai/core": minor
---

Export `createAgentHarnessRunContext` so hosts that call a harness adapter directly (such as a durable task executor) get the default artifact store, event sink and policy evaluator with their own abort signal. A primary agent declared as a non-root role, as in a persistent agent's single-role turn, now runs under its own role's tool policy instead of the coordinator's, and gets no `delegate_agent` tool when there is no other role to delegate to.
