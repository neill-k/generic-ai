# 0012. Bootstrap API And Starter Preset Default Path

Status: accepted

## Context

The planning tree requires a single obvious bootstrap entrypoint, with the starter preset as the default path and explicit overrides for advanced callers. At the same time, the plugin-host, run-mode, run-envelope, and `pi` boundary modules are still being built in parallel, so the bootstrap layer cannot hard-code those implementations yet.

## Decision

We expose `createGenericAI()` in `packages/core/src/bootstrap/` as the top-level bootstrap composition API. It returns a frozen runtime composition handle. The handle still preserves the descriptor fields (`preset`, `capabilities`, `ports`, and `describe()`), but now also owns a plugin-host-backed composition surface:

- preset plugin specs are registered as concrete plugin definitions
- dependency ordering is delegated to the plugin host
- startup lifecycle hooks are attached to every resolved plugin definition
- callers can inspect composed surfaces and invoke `run(task)` / `stream(task)`

The default preset is the starter Hono preset. The core bootstrap layer ships a matching internal starter descriptor, and `@generic-ai/preset-starter-hono` exports the same shape for callers who want to make the default path explicit.

Advanced callers can override the preset descriptor, plugin specs, plugin config, capabilities, and port descriptors without changing the rest of the bootstrap shape.

The bootstrap port descriptors are intentionally explicit about the expected upstream symbols:

- plugin host: `createPluginHost`
- run mode: `createSyncRunMode`
- run envelope: `createRunEnvelope`
- `pi` boundary: `pi`

## Consequences

- New callers have one obvious entrypoint.
- The starter preset remains the default path.
- The bootstrap layer stays decoupled from plugin packages while still composing the plugin host, lifecycle, run envelope, and streaming event primitives.
- Later runtime work can replace the minimal task executor with real `pi` AgentSession and tool bridging without changing the public bootstrap shape.

