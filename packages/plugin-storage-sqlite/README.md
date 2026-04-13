# @generic-ai/plugin-storage-sqlite

Durable local storage plugin backed by SQLite. This is the default persistence path for the starter preset.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Implement the shared storage contract with a SQLite-backed durable store
- Own its schema and init/bootstrap strategy
- Provide the default local persistence path for the starter preset
- Stay interchangeable with other storage implementations that honor the same contract

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
