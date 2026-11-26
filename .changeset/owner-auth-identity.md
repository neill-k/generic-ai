---
"@generic-ai/plugin-auth-identity": minor
"@generic-ai/sdk": minor
"@generic-ai/core": minor
"@generic-ai/plugin-hono": minor
---

Add single-owner auth and identity: SDK `AuthContext`/`RunActor` contracts, an optional `actor` on run envelopes and canonical events (stamped by `bootstrap.run(task, { actor })`), an `authenticate` hook in the Hono transport, and the new `@generic-ai/plugin-auth-identity` package with passkey owner login, revocable hashed API tokens, and cookie sessions.
