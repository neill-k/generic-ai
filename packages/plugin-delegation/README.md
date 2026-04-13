# @generic-ai/plugin-delegation

Delegation plugin for Generic AI. Provides a simple delegation capability on top of kernel child-session orchestration.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide a KISS delegation capability first
- Let the plugin define the delegation business model
- Rely on kernel child-session orchestration under the hood
- Emit delegation events that logging and observability plugins can consume

The kernel owns child session lifecycle and result collection. This plugin only owns the business shape of delegation itself.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
