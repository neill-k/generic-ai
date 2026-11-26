# @generic-ai/plugin-hono

Hono integration plugin for Generic AI. Official but optional at the framework level, and bundled by the starter preset so new users get a working transport out of the box.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide a Hono integration path for the starter and other presets
- Carry streaming runs cleanly over Hono
- Be included in the default preset without making core transport-bound

## Request body limits

`createHonoRunApp()` reads JSON request bodies with a streaming byte cap. The
default limit is 1 MiB. Pass `maxBodyBytes` when mounting the plugin to use a
smaller or larger bound for `/run` and `/run/stream` payloads.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`

## Authentication hooks

Two optional hooks run before `/run` and `/run/stream` read the request body:

- `authorize(context)` returns a `Response` to deny or `undefined` to allow.
- `authenticate(context)` returns `{ ok: false, response }` to deny or
  `{ ok: true, auth }` to allow. The `auth` value is an SDK `AuthContext` and
  is passed to the run and stream handlers as `context.auth`.

The plugin implements no credential scheme. Use
`@generic-ai/plugin-auth-identity` (`createOwnerAuthenticate`) or your own
handler. `/health` stays public.
