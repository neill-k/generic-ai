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

Cookie-authenticated requests that change state must come from the expected
origin. Bearer requests are not subject to that check.

## Storage

The plugin persists through `AuthKeyValueStore` (get, set, delete, list per
collection). Adapters ship for memory (`createMemoryAuthStore`) and any SDK
`StorageContract` (`createStorageContractAuthStore`). Keep the store outside
any directory agents can write to.
