# @generic-ai/plugin-workspace-fs

Local-filesystem workspace plugin. Provides the workspace contract implementation for agents, file tools, and memory.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide local filesystem workspace services
- Back local file tools so they do not reinvent path handling
- Expose recommended workspace layout helpers for agent memory, results, and shared data
- Stay within the filesystem contract the SDK exposes, so future workspace implementations remain swappable

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
