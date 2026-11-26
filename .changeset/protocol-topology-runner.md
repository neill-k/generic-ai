---
"@generic-ai/sdk": patch
"@generic-ai/core": patch
---

Execute Harness DSL protocol topologies. Standard pipeline, verifier-loop, hierarchy, and squad protocols are now stateful reducers over action outcomes, and core adds `runHarnessTopology()` plus the Pi-backed `runAgentHarnessTopology()` with concurrency, retries, budgets, cancellation, approvals, and causal traces.
