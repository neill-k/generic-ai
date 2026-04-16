# examples/starter-hono

Reference example for the Generic AI starter preset.

What this example shows:

- `createGenericAI()` with no arguments resolves the starter preset by default
- callers can still pass `createStarterHonoPreset()` explicitly when they want the composition to be visible in code
- the example keeps the bootstrap layer and the preset package separate, which matches the repo boundary model

The main source entrypoint is `examples/starter-hono/src/index.ts`. It stays small so the example can keep proving starter composition while later runtime work layers on a real provider-backed execution path.

The core package now also exposes a capability-to-`pi` runtime bridge (`createCapabilityPiAgentSession` / `runCapabilityPiAgentSession`) so the same starter capability stack can be projected into a real `AgentSession` when provider-facing runtime work is needed.

## Starter preset extension points

When the example needs customization, use programmatic contract extension points:

- slot overrides (for replacing defaults like storage/transport)
- addon plugins before/after a slot anchor

There is no separate user-facing `preset.yaml` file in v1.

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
