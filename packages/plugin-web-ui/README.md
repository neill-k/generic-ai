# `@generic-ai/plugin-web-ui`

Local-first Generic AI web console plugin.

This package intentionally lives in the plugin layer. It exposes browser client
components, a Hono transport adapter, guarded config editing through
`@generic-ai/plugin-config-yaml`, and a multi-agent architecture template
catalog.

The package does not import `@generic-ai/core` or presets. Hosts inject runtime
or harness execution behavior.

## Template Catalog

The built-in catalog includes runnable hierarchy-backed examples for common
agent structures: hierarchical planning, pipeline handoff, critic-verifier
review, hub-and-spoke coordination, and a Codex CLI Agent Loop example.

The Codex CLI Agent Loop template is inspired by `openai/codex`, but it is a
Generic AI config example rather than a dependency on Codex internals. It uses
the native `AgentHarnessConfig.loop` contract to model the structure that makes
Codex-style coding agents reliable: a durable thread/turn/item log, explicit
context assembly, typed tool routing, a permission gate for mutating effects,
streamed execution evidence, and a verification pass before final output.
