# Identity/Auth Plugin Roadmap

## Why

Identity and auth were intentionally deferred from the first working stack. The
starter preset now proves the framework can bootstrap, run through Hono, stream,
delegate, persist messages, and use local tools. That makes the next identity
question architectural rather than incidental: auth should be a replaceable
plugin boundary, not a kernel feature and not an ad hoc Hono middleware snippet.

`DEF-01` exists to make that future plugin path concrete enough to resume later
without rediscovering where identity belongs.

## Current posture

- The kernel has no user, tenant, role, session-cookie, token, or provider
  concept. It owns scope/session orchestration only.
- `@generic-ai/plugin-hono` owns the current HTTP transport routes and can carry
  request metadata into run handlers, but it does not authenticate requests.
- `@generic-ai/preset-starter-hono` includes Hono by default and exposes
  programmatic composition slots, but it does not yet expose an auth slot.
- The starter example is suitable for local development and now protects
  accidental remote exposure, but hosted deployments still need an explicit
  operator-owned auth layer before exposing run routes.

## Boundary decision

The future auth/identity surface should be a plugin family with SDK-visible
contracts, not a kernel responsibility.

- `@generic-ai/sdk` should eventually define the stable identity contract:
  authenticated subject, optional actor type, claims, scopes, credential source,
  auth strength, expiration, and redaction-safe audit metadata.
- `@generic-ai/plugin-auth-identity` should own identity-provider integration,
  token/session validation, principal normalization, auth context propagation,
  and auth-related event/audit payloads.
- `@generic-ai/plugin-hono` should remain transport-owned. It may expose adapter
  hooks or typed middleware slots, but it should not hard-code OAuth, OIDC, JWT,
  sessions, or provider-specific behavior.
- `@generic-ai/preset-starter-hono` should wire an auth plugin only when the
  operator opts in or selects a hosted profile. The local development preset can
  remain unauthenticated, but it must keep that posture explicit.
- `@generic-ai/core` should stay identity-agnostic. It should accept already
  normalized identity metadata as part of scope/session context, emit it in
  redaction-safe events where appropriate, and avoid making tenant or role
  assumptions.

## Non-goals

The first auth plugin should not become a product account system.

- Do not build a user-management UI in the framework.
- Do not make RBAC, billing, org charts, or tenancy models kernel concepts.
- Do not ship a password database as the default auth posture.
- Do not couple the framework to a single hosted identity vendor.
- Do not make Hono mandatory for non-HTTP consumers that can provide an
  authenticated subject through another transport.

## Hono integration implications

Hono should be the first adapter because the starter preset includes it by
default, but the boundary should stay portable.

- Protect `/run` and `/run/stream` before the handler reads the payload. The
  health route can remain public only when the operator deliberately chooses
  that posture.
- Use Hono middleware ordering deliberately: auth middleware must run before
  run/stream handlers and before any middleware that assumes an authenticated
  subject.
- Use typed Hono context variables for the normalized auth subject rather than
  passing provider-specific token payloads through route handlers.
- Keep bearer-token, cookie-session, and OIDC callback handling behind adapter
  configuration. Route handlers should see the same normalized subject shape
  regardless of credential style.
- Do not write secrets or raw tokens into Hono context, Generic AI events,
  stream chunks, logs, storage records, or run envelopes.
- Validate identity once before opening an SSE stream, then keep stream events
  tied to the request/session identity without re-emitting credentials.
- Treat CORS, CSRF, secure headers, and cookie attributes as deployment posture
  owned by the auth/Hono adapter configuration, not by the kernel.

## Security baseline

The default hosted path should start from standards-based identity, then make
local-only exceptions explicit.

- Prefer OIDC for end-user authentication and OAuth 2.0 for delegated API
  authorization. For browser-based sign-in, use the authorization-code flow and
  PKCE rather than implicit-style token exposure.
- Require TLS for hosted authorization, callback, token, and protected-resource
  traffic. Local development exceptions should be documented as local only.
- Require exact redirect URI registration and validate `state`/nonce values for
  browser flows.
- Validate token issuer, audience, expiration, not-before/issued-at where
  available, and signing keys. Cache JWKS carefully and support key rotation.
- Treat access tokens, refresh tokens, session IDs, and ID tokens as secrets.
  Store only the minimum needed, encrypt or hash persistent session references
  when storage is required, and redact every auth-bearing audit field by
  default.
- If a future credential-store mode is added, follow OWASP password-storage and
  authentication guidance: no silent truncation, no reversible password storage,
  modern password hashing, reauthentication for sensitive operations, session
  rotation, and MFA-friendly flows.
- Consider sender-constrained and audience-restricted access tokens for hosted
  or higher-risk deployments where replay resistance matters.

## Contract surfaces to add later

The future implementation should introduce these contracts before shipping a
concrete provider adapter:

```ts
interface AuthSubject {
  readonly subjectId: string;
  readonly issuer?: string;
  readonly displayName?: string;
  readonly actorType: "human" | "service" | "agent" | "unknown";
  readonly scopes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly authenticatedAt?: string;
  readonly expiresAt?: string;
}

interface AuthContext {
  readonly subject: AuthSubject;
  readonly credentialSource: "bearer" | "cookie" | "oidc" | "custom";
  readonly assurance?: "low" | "medium" | "high";
  readonly audit: Readonly<Record<string, unknown>>;
}
```

Expected integration points:

- SDK contract exports for `AuthSubject`, `AuthContext`, parser helpers, and
  redaction-safe audit payloads.
- Config-schema fragments for issuer, audience, JWKS, session-cookie, route
  protection, and public-health-route policy.
- Hono adapter hooks that convert middleware output into `AuthContext`.
- Scope/session metadata propagation so capability plugins can make policy
  decisions without importing a provider adapter.
- Event-stream fields that identify the authenticated subject without leaking
  credentials or full provider claims.

## Resume order

When the deferred track is resumed, split it into these slices:

1. **SDK and ADR foundation**
   - Add the auth contracts to `@generic-ai/sdk`.
   - Add parser/redaction helpers and contract tests.
   - Decide which identity fields are stable public API.
2. **Hono adapter**
   - Add auth middleware integration for `@generic-ai/plugin-hono`.
   - Protect run and stream routes with a normalized `AuthContext`.
   - Cover bearer/JWT validation first, with provider-specific OIDC as an
     adapter layer rather than transport core.
3. **Preset and config**
   - Add an optional auth slot to `@generic-ai/preset-starter-hono`.
   - Add YAML config fragments for hosted auth posture.
   - Keep unauthenticated local mode explicit and isolated from hosted defaults.
4. **Runtime propagation**
   - Carry redaction-safe identity metadata into scope/session creation.
   - Expose identity metadata to governance, tools, logging, and output plugins
     through SDK contracts rather than transport internals.
5. **Provider and session hardening**
   - Add OIDC discovery/JWKS support, session rotation, token redaction tests,
     and hosted deployment guidance.
   - Add integration tests for denied requests, expired tokens, audience/issuer
     mismatch, protected stream startup, and redaction.

## Exit criteria for the future implementation track

The auth track is ready to close only when:

- the kernel remains free of provider, token, cookie, user, role, and tenant
  assumptions;
- Hono run and stream routes can be protected by a replaceable auth plugin;
- normalized identity metadata is available to scope/session creation and
  policy-capable plugins through SDK contracts;
- hosted presets can require auth without breaking local development defaults;
- token/session secrets never appear in events, logs, storage, stream chunks, or
  run envelopes;
- docs explain the local unauthenticated posture, the hosted authenticated
  posture, and the migration path between them.

## Source anchors

The roadmap above is grounded in the official guidance below:

- [Hono middleware guide](https://www.honojs.com/docs/guides/middleware)
- [Hono JWT middleware](https://hono.dev/docs/middleware/builtin/jwt)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-18.html)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
