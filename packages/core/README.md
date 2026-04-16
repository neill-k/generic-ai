# @generic-ai/core

The Generic AI framework kernel. This package owns the minimal framework control plane and nothing else.

Kernel responsibilities (see `docs/planning/02-architecture.md`):

- Top-level bootstrap entrypoint
- Plugin host, manifest validation, dependency ordering, and lifecycle
- Plugin registries and composition surfaces
- First-class `Scope` primitive
- Root and child session orchestration
- Canonical streaming event model for run and session lifecycle
- Canonical run envelope returned to callers
- Config discovery, validation, and composition wiring

The kernel does not own business capabilities. MCP, Agent Skills, delegation, messaging, memory, storage, output shaping, and transport all live in plugins.

Current bootstrap boundary:

- `createGenericAI(options)` is the generic bootstrap entrypoint
- callers provide a preset contract or use the internal starter descriptor rather than the kernel importing preset packages directly
- the bootstrap result is a frozen runtime composition handle with the resolved plugin host, ordered plugin instances, composed surfaces, and `run(task)` / `stream(task)` methods
- plugin-host dependency ordering is the source of truth for startup order; each resolved plugin definition carries setup/start/stop lifecycle hooks
- starter-path convenience wrappers live in preset packages such as `@generic-ai/preset-starter-hono`

Current runtime bridge:

- `resolveCapabilityPiToolRegistry(capabilities)` assembles the stable `pi` tool registry from capability plugins
- `createCapabilityPiAgentSession(options)` wires capability tools plus Agent Skills into a real `pi` `AgentSession`
- `runCapabilityPiAgentSession(options)` forwards `pi` session activity into the canonical event stream and run envelope

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
