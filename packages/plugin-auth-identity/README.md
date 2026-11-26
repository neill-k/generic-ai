# @generic-ai/plugin-auth-identity

Single-owner auth and identity for hosted Generic AI deployments: passkey
(WebAuthn) owner login, revocable API tokens, cookie sessions, and Hono
adapters that turn a request into the SDK's normalized `AuthContext`.

Version one has exactly one owner. There are no tenants, signup, or roles
beyond scopes. See `docs/identity-auth.md` and
`docs/decisions/0045-owner-auth-identity.md`.

## Quick start

```ts
import { createHonoPlugin } from "@generic-ai/plugin-hono";
import {
  createMemoryAuthStore,
  createOwnerAuth,
  createOwnerAuthenticate,
  createOwnerAuthRoutes,
} from "@generic-ai/plugin-auth-identity";
import { toRunActor } from "@generic-ai/sdk";

const auth = createOwnerAuth({
  store: createMemoryAuthStore(), // use a durable store in production
  publicOrigin: "https://my-app.up.railway.app",
  setupToken: process.env.GENERIC_AI_OWNER_SETUP_TOKEN,
});

const transport = createHonoPlugin({
  routePrefix: "/starter",
  authenticate: createOwnerAuthenticate(auth),
  run: (payload, context) =>
    bootstrap.run(task, context.auth ? { actor: toRunActor(context.auth) } : {}),
});
transport.app.route("/", createOwnerAuthRoutes(auth).app);
```

## Credentials

| Credential | How it is presented | Stored as | Scopes |
| --- | --- | --- | --- |
| Passkey session | `gai_session` cookie (`__Host-` and `Secure` on https), HttpOnly, SameSite=Lax | SHA-256 of the session secret | all |
| API token `gai_<id>_<secret>` | `Authorization: Bearer …` or `x-generic-ai-token` | SHA-256 of the secret | chosen at creation |
| Static token | same as API token | SHA-256 in memory | configured |

Scopes are `runs:execute`, `runs:read`, and `tokens:manage` (from
`AUTH_SCOPES` in `@generic-ai/sdk`). A caller cannot create a token with
scopes it does not hold.

## HTTP surface

`createOwnerAuthRoutes(auth, { routePrefix: "/auth" })` mounts:

- `GET /auth/login` self-contained login, first-time setup, and token page
- `GET /auth/session` sign-in state, never secrets
- `POST /auth/passkeys/register/options` and `/verify` add a passkey; the first
  one needs the setup token, later ones a signed-in owner
- `POST /auth/passkeys/login/options` and `/verify` sign in
- `POST /auth/logout`
- `GET /auth/passkeys`, `DELETE /auth/passkeys/:id` (refuses the last one)
- `GET /auth/tokens`, `POST /auth/tokens`, `DELETE /auth/tokens/:id`

- `POST /auth/sessions/revoke-others` sign out every other browser session

Cookie-authenticated requests that change state must come from the expected
origin. Bearer requests are not subject to that check.

Sessions are rotated around sensitive changes: signing in revokes any session
the browser already held (no session fixation), and adding or removing a
passkey or signing out other sessions swaps the caller's cookie for a fresh
one. Removing a passkey also ends every session that passkey created.

## Sign-in rate limiting

Failed setup-token and passkey attempts are counted per client (5 per 15
minutes by default) and across all clients (50), and answered with `429` and
`Retry-After` once over budget. A completed sign-in clears the client's count.
At most 100 sign-in challenges may be open at once. The client key is the TCP
peer address the starter's Node server attaches; pass `trustProxyHeaders: true`
behind a proxy you control to use the last `X-Forwarded-For` hop, or supply
`clientKey`. Pass `rateLimiter: false` to turn it off, or your own
`createAuthRateLimiter(...)`. State is in process memory.

## Storage

The plugin persists through `AuthKeyValueStore` (get, set, delete, list per
collection). Adapters ship for memory (`createMemoryAuthStore`) and any SDK
`StorageContract` (`createStorageContractAuthStore`), which covers
`@generic-ai/plugin-storage-postgres` (`openPostgresStorage().storage`). Keep
the store outside any directory agents can write to.
