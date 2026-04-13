# @generic-ai/plugin-tools-terminal

Standard local terminal tool for Generic AI agents, packaged as a `pi` tool.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Ship a standard `pi` tool for local command execution
- Expose the tool to the starter preset toolbelt
- Start unrestricted for local workspace use in v1, with hardening tracked under the deferred governance track

This plugin is intentionally split from `@generic-ai/plugin-tools-files` so consumers can opt into only the surface they need.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
