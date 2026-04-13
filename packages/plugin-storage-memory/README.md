# @generic-ai/plugin-storage-memory

In-memory implementation of the storage contract. Targets tests and fast local development where durability is not required.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Implement the shared storage contract with an in-process memory backend
- Allow the rest of the framework and its tests to run without external infrastructure
- Match the behavior expected by storage-dependent plugins (messaging, memory, etc.)

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
