# `@generic-ai/plugin-web-ui`

Local-first Generic AI web console plugin.

This package intentionally lives in the plugin layer. It exposes browser client
components, a Hono transport adapter, guarded config editing through
`@generic-ai/plugin-config-yaml`, and a multi-agent architecture template
catalog.

The package does not import `@generic-ai/core` or presets. Hosts inject runtime
or harness execution behavior.

Runnable templates rely on the core default agent loop: generated agents and
harnesses keep working until the runtime-injected `stop_and_respond` tool is
called, with no generated finite `maxTurns` cap. Hosts can still honor
`execution.turnMode: single-turn` for template experiments that intentionally
need a one-shot provider call, or add `execution.maxTurns` when they want a
finite template safety cap.
