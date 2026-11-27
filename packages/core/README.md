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
- Native `AgentHarness` runtime over SDK adapter context, effect-described
  tool policy, canonical harness events, and URI/hash artifacts

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

- `resolveCapabilityPiToolRegistry(capabilities)` assembles the stable tool registry from capability plugins (the `Pi` in the name is historical)
- `runCapabilityNativeAgentSession(options)` runs capability tools plus Agent Skills as a native agent session and forwards its activity into the canonical event stream and run envelope
- The native agent owns the per-prompt model/tool loop. Generic AI adds the terminal
  run contract around it: the runtime injects `stop_and_respond`, marks that
  tool result as terminal, re-enters the same conversation if the model
  finishes with a plain assistant message, and only returns once the stop tool
  is called. Set `execution.turnMode: single-turn` in agent or harness config
  for deliberately one-shot behavior. `execution.maxTurns` is optional; when
  omitted, the stop-tool loop is unbounded and relies on the stop tool,
  cancellation, or provider/session failure to end the run.
- Auto-compaction runs before each prompt when the context nears the model's
  window (`@generic-ai/session`); pass `compaction: false` to turn it off.
- `createDelegationCoordinator(options)` keeps child-session lifecycle plumbing in the kernel while delegation business contracts stay outside core
- `createAgentHarness(options)` / `runAgentHarness(options)` run the composable
  harness control plane above the native runtime; `GenericAILlmRuntime` remains the low-level
  text/model helper
- Harness role binding is effect-based. Every role, the primary agent
  included, gets the tools its policy profile allows; `readOnly: true` limits a
  role to read effects. There are no fixed patterns between roles (ADR 0071).
- Agent lifecycle hooks can inject prompt context, observe permission decisions,
  wrap supported tool calls, and record `hook.*` events plus hook-decision
  artifacts.

Models are resolved by `resolveNativeModel`: `provider/id` as given, or a bare
id routed by family (`claude-*` to Anthropic, anything else to OpenAI). API keys
come from `GENERIC_AI_PROVIDER_API_KEY` or the provider's own environment
variable.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
