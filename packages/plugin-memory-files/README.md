# @generic-ai/plugin-memory-files

File-backed persistent agent memory plugin for Generic AI.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide file-backed persistent agent memory
- Support persistent read, write, and search operations
- Depend on `@generic-ai/plugin-workspace-fs` for filesystem access instead of re-implementing path handling
- Document its file layout and retrieval behavior so alternate memory plugins can follow the same contract

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
