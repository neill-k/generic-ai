# 0015. Identity/Auth Plugin Boundary

Status: accepted

## Context

Identity/auth was deliberately deferred from the first Generic AI framework
implementation. The current kernel and starter stack are now capable enough to
make the boundary decision concrete:

- the kernel owns bootstrap, plugin host, scope, sessions, events, and run
  envelopes;
- Hono is an official optional transport plugin and is included by the starter
  preset;
- runtime governance remains plugin-owned rather than kernel-owned;
- the starter preset is local-first and can be exposed through Hono, so hosted
  deployments need a clear auth path before exposing run routes.

External guidance points toward the same shape. Hono models authentication as
middleware and typed context variables, OpenID Connect places authentication on
top of OAuth 2.0, OAuth 2.0 security guidance now centers PKCE, redirect
validation, token confidentiality, issuer/audience checks, and replay
resistance, and OWASP treats authentication, session management, and password
storage as separate security responsibilities that need explicit handling.

## Decision

Identity/auth will be implemented as a future plugin family with SDK-visible
contracts, not as a kernel feature.

- `@generic-ai/sdk` will eventually own stable identity types such as
  authenticated subject, claims, scopes, credential source, assurance level,
  expiration, and redaction-safe audit metadata.
- A future `@generic-ai/plugin-auth-identity` package will own token/session
  validation, identity-provider integration, principal normalization, and
  propagation of auth context into framework execution.
- `@generic-ai/plugin-hono` will provide transport adapter hooks for auth
  middleware but will not hard-code OIDC, OAuth, JWT, cookies, sessions, or a
  specific identity provider.
- `@generic-ai/preset-starter-hono` will keep local unauthenticated development
  explicit while allowing hosted profiles to opt into or require the auth plugin.
- `@generic-ai/core` will remain identity-agnostic. It may carry normalized,
  redaction-safe identity metadata inside scope/session context and events, but
  it will not own users, tenants, roles, providers, cookies, or token rules.

The concrete roadmap is recorded in `docs/identity-auth.md`.

## Consequences

- The existing kernel/plugin boundary stays intact.
- Hono can be the first implementation target without making auth transport-only
  or Hono-only.
- Capability plugins and future governance policy can consume a normalized
  subject through SDK contracts instead of importing provider-specific code.
- Hosted deployments get a clear path to protect run and stream routes while
  local development remains simple.
- Future implementation work must touch multiple packages because the shared
  identity contract, Hono adapter, preset wiring, config, events, and docs all
  need to agree.

## Alternatives considered

### Put auth in the kernel

Rejected because auth is a business and deployment boundary, not a core session
or plugin-host primitive. Kernel-owned auth would pull provider, token, tenant,
and role assumptions into the most stable layer of the framework.

### Make auth a Hono-only middleware recipe

Rejected because Hono is only one transport. A middleware recipe would protect
HTTP routes but would not give capability plugins, governance, logging, or
non-Hono transports a stable identity contract.

### Require one hosted identity provider

Rejected because Generic AI should remain a framework. The auth boundary should
support OIDC/OAuth-compatible providers and custom adapters without binding the
public framework shape to one vendor.

### Leave auth fully external to Generic AI

Rejected because external-only auth would protect the edge but leave runs,
events, tool policy, audit output, and future governance without a normalized
subject model.
