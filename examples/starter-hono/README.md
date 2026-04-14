# examples/starter-hono

Reference example for the Generic AI starter preset.

What this example shows:

- `createGenericAI()` with no arguments resolves the starter preset by default
- callers can still pass `createStarterHonoPreset()` explicitly when they want the composition to be visible in code
- the example keeps the bootstrap layer and the preset package separate, which matches the repo boundary model

The main source entrypoint is `examples/starter-hono/src/index.ts`. It is intentionally small for now so later runtime work can swap in the real kernel wiring without changing the example shape.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
