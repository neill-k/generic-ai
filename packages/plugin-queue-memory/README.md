# @generic-ai/plugin-queue-memory

In-process queue plugin for Generic AI. Implements the queue contract so the async execution path works without external infrastructure.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Implement in-process queueing that plugs into the shared session machinery
- Provide the async execution path for local development and test coverage
- Preserve a clean replacement path for future external queues (BullMQ, etc.)

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
