---
"@generic-ai/sdk": minor
"@generic-ai/core": patch
"@generic-ai/plugin-approvals": minor
"@generic-ai/plugin-delegation": minor
---

Add owner approvals for outward actions: an SDK approval policy and service contract, `approval.*` canonical events, the `approvals:decide` auth scope, a new `@generic-ai/plugin-approvals` package (durable requests on the run store, a tool gate, Hono inbox routes, a topology approver), and delegation cascade support for parking a task until the owner decides.
