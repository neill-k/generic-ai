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
- Consuming compiled Harness DSL / Generic Agent IR contracts for runtime and
  benchmark execution

The kernel does not own business capabilities. MCP, Agent Skills, delegation, messaging, memory, storage, output shaping, and transport all live in plugins.

The kernel also does not own Harness DSL syntax, package-specific protocol
semantics, policy interpretation, grader definitions, or report renderer
semantics. Those live in SDK contracts and package extensions.

Current bootstrap boundary:

- `createGenericAI(options)` is the generic bootstrap entrypoint
- `createGenericAIFromConfig(options)` loads or accepts resolved canonical config, validates it through an injected config loader, and produces the runtime/session/plugin-init plan before runtime start
- callers provide a preset contract or use the mirrored internal starter descriptor rather than the kernel importing preset packages directly
- the bootstrap result is a frozen runtime composition handle with the resolved plugin host, ordered plugin instances, composed surfaces, and `run(task)` / `stream(task)` methods
- plugin-host dependency ordering is the source of truth for startup order; each resolved plugin definition carries setup/start/stop lifecycle hooks
- starter-path convenience wrappers live in preset packages such as `@generic-ai/preset-starter-hono`
- the kernel accepts config loader and schema registry hooks, but does not import `@generic-ai/plugin-config-yaml` directly
- the mirrored starter descriptor is an approved bootstrap-only boundary exception recorded in `docs/decisions/0012-bootstrap-api.md`; core still must not import plugin or preset packages

Current runtime bridge:

- `resolveCapabilityPiToolRegistry(capabilities)` assembles the stable `pi` tool registry from capability plugins
- `createCapabilityPiAgentSession(options)` wires capability tools plus Agent Skills into a real `pi` `AgentSession`
- `runCapabilityPiAgentSession(options)` forwards `pi` session activity into the canonical event stream and run envelope
- `createDelegationCoordinator(options)` keeps child-session lifecycle plumbing in the kernel while delegation business contracts stay outside core
- `runHarnessBenchmark(options)` compiles Harness DSL contracts from the SDK,
  then runs trials through the same `GenericAILlmRuntime` used by normal runs

OpenAI Codex inference uses Pi's `openai-codex` provider path. The
`openai-codex` adapter resolves credentials and models through Pi auth/model
storage and creates a Pi `AgentSession`.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
