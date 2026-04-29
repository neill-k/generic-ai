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
