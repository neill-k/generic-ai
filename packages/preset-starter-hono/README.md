# @generic-ai/preset-starter-hono

Default starter preset contract for Generic AI. This package exports a first-class preset contract plus convenience helpers so callers can wire the starter path without requiring `@generic-ai/core` to import plugin packages directly.

## What this package exports

- `starterPresetContract`: canonical starter preset contract metadata and resolver
- `resolveStarterPreset(options?)`: resolves the deterministic plugin composition order
- `createStarterHonoPreset(options?)`: builds the bootstrap-ready starter preset definition
- `createStarterHonoBootstrapFromYaml(options)`: starter convenience that injects `loadCanonicalConfig()` into `createGenericAIFromConfig()` so canonical YAML drives runtime/session/plugin init planning
- `STARTER_PRESET_DEFAULT_SLOTS`: documented slot-to-plugin defaults for the starter stack

The preset keeps Hono in the default path, and callers can pass it straight into `createGenericAI()` when they want to make the composition explicit.

The default composition is local-first and includes:

- canonical config plugin
- workspace filesystem services
- durable SQLite storage
- in-process queueing
- OTEL logging
- terminal and file tools
- MCP and Agent Skills
- delegation, messaging, and file-backed memory
- default output/finalization
- Hono transport by default

## Extension points (programmatic, v1)

This package intentionally uses programmatic extension points in v1.

- `slotOverrides`: replace a default slot plugin, or disable optional slots (for example, `transport` / Hono)
- `addons`: insert additional plugins before or after a slot anchor

Example:

```ts
import { resolveStarterPreset } from "@generic-ai/preset-starter-hono";

const preset = resolveStarterPreset({
  slotOverrides: [{ slot: "storage", pluginId: "@acme/plugin-storage-postgres" }],
  addons: [{ pluginId: "@acme/plugin-policy", anchorSlot: "output", insert: "before" }],
});
```

## No `preset.yaml` in v1

There is no separate user-facing `preset.yaml` in v1. Preset composition is defined by this package contract and can be customized programmatically via the extension points above.

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md` (`CFG-04`)
- `docs/package-boundaries.md`
