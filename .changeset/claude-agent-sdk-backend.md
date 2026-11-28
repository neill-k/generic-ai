---
"@generic-ai/sdk": minor
"@generic-ai/core": minor
---

Add the `claude-agent-sdk` harness adapter kind and `CreateAgentHarnessOptions.backends`. A host can register a `HarnessSessionBackend` under its kind and get the same plumbing the native backend has (role and profile policy, secrets, host tools, lifecycle hooks, usage meter, artifacts). Generic Corp uses it to run Claude turns in the Claude Agent SDK on the owner's Claude plan.
