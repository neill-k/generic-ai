# 0045 Owner Auth And Identity (Single Owner, v1)

- Status: accepted
- Date: 2026-11-26
- Roadmap item: R10 (auth and identity)

## Context

Hosted Generic AI deployments (Generic Corp on Railway first) were protected by
one static bearer token from `GENERIC_AI_AUTH_TOKEN`. That token could not be
rotated without a redeploy, could not be scoped, and gave no way to tell who
started a run. Version one has a single owner: no tenants, no signup, no
billing. `docs/identity-auth.md` already fixed the boundary: identity is a
plugin with SDK contracts, Hono stays transport-only, and the kernel carries
only normalized, redaction-safe identity metadata.

## Decision

1. **SDK contracts.** `@generic-ai/sdk` defines `AuthSubject`, `AuthContext`,
   the redaction-safe `RunActor` projection, `toRunActor`, `parseRunActor`,
   `hasAuthScope`, and the baseline scopes `runs:execute`, `runs:read`, and
   `tokens:manage`.
2. **Runtime propagation.** `RunEnvelope` and `CanonicalEventContext` gain an
   optional `actor: RunActor`. The core bootstrap's `run(task, { actor })` and
   `stream(task, { actor })` stamp it on the envelope, every bootstrap run
   event, and the task context. The kernel never sees credentials, claims, or
   provider payloads.
3. **Transport hook.** `@generic-ai/plugin-hono` adds an `authenticate`
   option. It runs before the body is read and either rejects with a response
   or passes an `AuthContext` to the run and stream handlers. The existing
   `authorize` hook keeps working.
4. **Owner login is a passkey (WebAuthn).** `@generic-ai/plugin-auth-identity`
   uses `@simplewebauthn/server` for verification, requires user verification
   and discoverable credentials, and issues an HttpOnly, SameSite=Lax session
   cookie (`__Host-` prefixed and `Secure` on https). The first passkey is
   registered with a one-time setup token from configuration or the server
   log; later passkeys need a signed-in owner.
5. **API tokens.** Tokens look like `gai_<16 hex id>_<43 char secret>`. Only
   the SHA-256 of the secret is stored, compared in constant time. Tokens carry
   scopes, an optional expiry, a last-used timestamp, and can be revoked. A
   caller cannot mint a token with scopes it does not hold.
6. **Storage port.** The plugin persists through a five-method
   `AuthKeyValueStore`, with adapters for memory and the SDK `StorageContract`.
   The starter example backs it with `@generic-ai/plugin-storage-sqlite` and
   refuses to place the database inside the agent workspace, because an agent
   that can write the auth store could mint its own credentials.
7. **Break-glass token.** `GENERIC_AI_AUTH_TOKEN` still works as a static owner
   token (now at least 16 characters), recorded as credential
   `env:GENERIC_AI_AUTH_TOKEN`.

## Why passkeys rather than OIDC for v1

- A self-hosted single-owner app on Railway has no identity provider to lean
  on. OIDC would need the operator to register an OAuth client with Google,
  GitHub, or similar, keep a client secret in Railway, and register exact
  redirect URIs per domain before the app is usable.
- A passkey needs nothing outside the deployment: the relying party id is the
  Railway domain (`RAILWAY_PUBLIC_DOMAIN`), and the owner registers once.
- Passkeys are phishing resistant and are not a password database, which
  `docs/identity-auth.md` rules out as a default.
- The cost is recovery: losing every passkey locks the owner out of the
  browser. Mitigations are registering more than one passkey (the plugin
  refuses to delete the last one), the break-glass `GENERIC_AI_AUTH_TOKEN`, and
  API tokens with `tokens:manage`.

OIDC remains the right adapter for multi-user or organization deployments and
fits the same `AuthContext` shape; it is deferred, not rejected.

## Consequences

- Run envelopes and events answer "who acted" for later approval and audit
  work without leaking credentials.
- Browser state-changing requests that rely on the cookie must carry a
  same-origin `Origin` (or `Sec-Fetch-Site: same-origin`); bearer callers are
  unaffected.
- Durable auth lives in Postgres when `DATABASE_URL` is set (the same
  `kv_records` table as the R6 store), otherwise in a SQLite file that needs a
  persistent volume. `GENERIC_AI_AUTH_DB=:memory:` is for tests only.
- Failed sign-in and setup attempts are rate limited in memory, per client and
  globally, and open challenges are capped.
- Web console chat runs record the actor on the user message, the
  `run.started` console event, and every harness run event
  (`AgentHarnessRunInput.actor`, `CanonicalEventStreamOptions.actor`).
- Sessions rotate around sensitive changes: sign-in revokes any session the
  browser already held, adding or removing a passkey rotates the caller's
  cookie, and `POST /auth/sessions/revoke-others` signs out every other
  session.
- Not yet done: the actor on durable run store records (lands with R8/R9).
  OIDC stays out of scope while v1 has a single owner.
