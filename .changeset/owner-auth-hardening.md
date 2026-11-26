---
"@generic-ai/plugin-auth-identity": minor
"@generic-ai/plugin-web-ui": minor
"@generic-ai/core": minor
"@generic-ai/sdk": minor
---

Harden owner auth: rate limit failed sign-in and setup attempts (per client and globally) and cap open challenges; record the actor on web console chat runs through a `resolveActor` transport option, `AgentHarnessRunInput.actor`, and a stream-level `actor` on canonical event streams.
