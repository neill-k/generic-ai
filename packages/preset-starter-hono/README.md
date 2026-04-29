# @generic-ai/preset-starter-hono

Default starter preset contract for Generic AI. This package exports a first-class preset contract plus convenience helpers so callers can wire the starter path without requiring `@generic-ai/core` to import plugin packages directly.

## What this package exports

- `starterPresetContract`: canonical starter preset contract metadata and resolver
- `resolveStarterPreset(options?)`: resolves the deterministic plugin composition order
- `createStarterHonoPreset(options?)`: creates a bootstrap-ready preset definition with resolved plugin specs
- `starterHonoPreset`: the default bootstrap-ready starter preset definition
- `createStarterHonoBootstrapFromYaml(options)`: starter convenience that injects `loadCanonicalConfig()` into `createGenericAIFromConfig()` so canonical YAML drives runtime/session/plugin init planning
- `resolveStarterSandboxSelection(mode?, options?)`: resolves `GENERIC_AI_SANDBOX` / environment defaults, probes Docker reachability, and returns the terminal plugin choice that bootstrap should use
- `STARTER_PRESET_DEFAULT_SLOTS`: documented slot-to-plugin defaults for the starter stack

The preset keeps Hono in the default path, and callers can pass it straight into `createGenericAI()` when they want to make the composition explicit. The returned preset includes plugin specs that core registers into the plugin host, so dependency ordering remains host-owned during bootstrap.

`@generic-ai/core` also keeps a mirrored starter descriptor so bare `createGenericAI()` calls can stay on the starter path without importing preset packages directly. That mirrored descriptor is a documented bootstrap-only exception; this package remains the public starter contract and convenience-wrapper owner.

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

The starter preset also exposes a first-class `terminalTools` slot, so callers can switch the terminal implementation without forking the preset definition:

```ts
import { createStarterHonoPreset } from "@generic-ai/preset-starter-hono";

const preset = createStarterHonoPreset({
  sandboxMode: "docker",
});
```

## Sandbox mode at bootstrap

`createStarterHonoBootstrapFromYaml()` now understands starter sandbox selection for the terminal slot:

- `GENERIC_AI_SANDBOX=docker` switches `terminalTools` to `@generic-ai/plugin-tools-terminal-sandbox`
- `GENERIC_AI_SANDBOX=none` keeps the default unrestricted `@generic-ai/plugin-tools-terminal`
- when `GENERIC_AI_SANDBOX` is unset, development defaults to `none` and production defaults to `docker`
- Docker reachability is checked during bootstrap; if Docker is unavailable, production fails closed by default
- development still warns and falls back to the unrestricted terminal by default so local clones remain easy to boot
- set `GENERIC_AI_SANDBOX_FALLBACK=warn` to explicitly allow fallback when Docker is unavailable
- set `GENERIC_AI_SANDBOX_FALLBACK=fail` to make fallback a hard bootstrap error in any environment

This package only resolves the preset composition and bootstrap warning/fallback behavior. The sandbox backend package still owns the actual container execution implementation.

To migrate the starter path from unrestricted host execution to the sandbox
plugin, override the `terminalTools` slot explicitly:

```ts
import { createStarterHonoBootstrapFromYaml } from "@generic-ai/preset-starter-hono";

const bootstrap = await createStarterHonoBootstrapFromYaml({
  startDir: process.cwd(),
  slotOverrides: [
    {
      slot: "terminalTools",
      pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
      description: "Docker-backed sandbox terminal execution.",
    },
  ],
});
```

See [`../../docs/sandbox/operator-guide.md`](../../docs/sandbox/operator-guide.md)
and
[`../../docs/sandbox/migration-guide.md`](../../docs/sandbox/migration-guide.md)
for the operational rollout guidance.

## No `preset.yaml` in v1

There is no separate user-facing `preset.yaml` in v1. Preset composition is defined by this package contract and can be customized programmatically via the extension points above.

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md` (`CFG-04`)
- `docs/package-boundaries.md`
