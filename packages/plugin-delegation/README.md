# @generic-ai/plugin-delegation

Delegation capability contract markers for Generic AI. This package exports the
delegation capability identity plus the shared request/result types while the
kernel owns child-session lifecycle and result collection.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide a KISS delegation capability first
- Let the plugin define the delegation business model
- Rely on kernel child-session orchestration under the hood
- Emit delegation events that logging and observability plugins can consume

Current boundary:

- `@generic-ai/core` exposes `createDelegationCoordinator()` for child-session
  lifecycle plumbing
- `@generic-ai/plugin-delegation` exports the delegation capability markers and
  shared contract types
- the package must not depend on `@generic-ai/core`

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
