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
- `createGenericAIFromConfig(options)` loads or accepts resolved canonical config, validates it through an injected config loader, and produces the runtime/session/plugin-init plan before runtime start
- callers provide a preset contract rather than the kernel importing preset packages directly
- starter-path convenience wrappers live in preset packages such as `@generic-ai/preset-starter-hono`
- the kernel accepts config loader and schema registry hooks, but does not import `@generic-ai/plugin-config-yaml` directly

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
