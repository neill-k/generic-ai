# @generic-ai/plugin-messaging

Durable inter-agent messaging for Generic AI. Storage-backed so messages survive across runs and independent sessions.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide durable inter-agent messaging
- Be storage-backed in v1, depending on the storage contract, not on a specific implementation
- Let agents exchange messages independently of a single in-memory session
- Document the messaging shape for plugin consumers

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
