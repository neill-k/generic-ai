# `@generic-ai/plugin-web-ui`

Local-first Generic AI web console plugin.

This package intentionally lives in the plugin layer. It exposes browser client
components, a Hono transport adapter, guarded config editing through
`@generic-ai/plugin-config-yaml`, and a multi-agent architecture template
catalog.

The package does not import `@generic-ai/core` or presets. Hosts inject runtime
or harness execution behavior.
