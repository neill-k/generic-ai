# @generic-ai/plugin-tools-files

Standard local file tools for Generic AI agents, packaged as `pi` tools.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Ship standard `pi` tools for reading, writing, listing, and editing files
- Integrate with `@generic-ai/plugin-workspace-fs` so tools share a consistent view of the workspace
- Start unrestricted for local workspace use in v1, with hardening tracked under the deferred governance track

The concrete hardening roadmap for this deferred track now lives in
[`docs/runtime-governance.md`](../../docs/runtime-governance.md).

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
