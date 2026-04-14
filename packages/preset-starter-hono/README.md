# @generic-ai/preset-starter-hono

The default Generic AI starter preset. It keeps Hono in the default path, and callers can pass it straight into `createGenericAI()` when they want to make the composition explicit.

Current surface:

- `createStarterHonoPreset()` returns a frozen preset descriptor with the default local-first starter shape
- `starterHonoPreset` is the package-level default descriptor
- the preset exposes composition ports for plugin-host, run-mode, run-envelope, and `pi` boundary wiring
- the reference example in `examples/starter-hono/` shows both the implicit default path and an explicit override

Design notes:

- the preset is intentionally a composition descriptor, not a kernel implementation
- the actual plugin host, run-mode, run-envelope, and `pi` wiring remain in the kernel / SDK layers
- the starter preset should optimize for "it works" over custom assembly

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
