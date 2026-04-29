# Generic AI And `pi`

Generic AI is not trying to beat `pi` at being `pi`.

The design goal is to use `pi` for the low-level agent and tool runtime mechanics, then provide a framework shell for people who need a composed, replaceable, multi-agent runtime.

The root `@generic-ai/sdk` contract remains runtime-agnostic. Pi-specific
runtime and tool compatibility primitives are exposed through the explicit
subpath `@generic-ai/sdk/pi`.
At the harness layer, adapter selection is explicit (`pi` or other registered
adapters), so Pi remains the default reference path rather than the required
runtime ontology.

## Short Version

`pi` is the agent toolkit layer. Generic AI is the application framework layer.

Use `pi` directly when you want:

- a lean terminal coding agent,
- a multi-provider model/runtime toolkit,
- direct tool-calling and agent-state primitives,
- terminal or web UI building blocks,
- a lightweight surface you can customize with extensions, skills, prompts, and packages.

Use Generic AI when you want:

- a package-extensible agents-as-code language,
- a plugin-first multi-agent framework,
- a stable SDK contract for plugin and preset authors,
- compiled Generic Agent IR before runtime execution,
- canonical config discovery and validation,
- root and child session orchestration,
- durable inter-agent messaging,
- persistent file-backed memory with search,
- standard local terminal, file, web, MCP, and Agent Skills capabilities,
- sync and queue-backed async run paths,
- Hono transport and a starter preset that works by default,
- operational boundaries for docs, CI, ownership, release, and sandboxed execution.

## Why Build Generic AI If `pi` Exists?

`pi` is a strong foundation for individual agent execution and developer-facing agent workflows. Generic AI exists for the next layer up: building systems where multiple capabilities need to be composed, swapped, configured, persisted, observed, and embedded behind an application boundary.

The core question is not "which one is better?" It is "which layer are you trying to work at?"

| Need | Better fit |
| --- | --- |
| Run or customize a terminal coding agent | `pi` |
| Use a multi-provider model API or agent loop directly | `pi` |
| Build a TUI or UI surface around agent interaction | `pi` UI/toolkit packages |
| Embed one agent runtime in a custom process | `pi` or Generic AI, depending on surrounding requirements |
| Compose many replaceable capabilities into one runtime | Generic AI |
| Give third-party plugins a stable framework-facing contract | Generic AI |
| Provide durable messaging, memory, queueing, config, transport, and output through package boundaries | Generic AI |
| Ship a default local-first multi-agent stack with room to swap pieces later | Generic AI |

## What Generic AI Adds Around `pi`

Generic AI intentionally builds on `pi` instead of forking it or rebuilding every primitive.

The added value is the framework control plane:

- **Bootstrap and presets.** `createGenericAI()` and `@generic-ai/preset-starter-hono` give callers a default working stack while still allowing explicit custom composition.
- **Plugin host.** The kernel registers plugins, validates manifests, orders dependencies, runs lifecycle hooks, and exposes registries.
- **SDK contracts.** `@generic-ai/sdk` defines the framework-facing contracts plugin authors compile against, including scope, storage, workspace, queue, output, plugin lifecycle, and registry contracts.
- **Agents-as-code contracts.** Harness DSL, Generic Agent IR, MissionSpec,
  BenchmarkSpec, traces, reports, policies, and patches are public SDK
  contracts for package-composed agent systems.
- **Canonical config.** `@generic-ai/plugin-config-yaml` owns YAML discovery, validation, schema composition, and resolved config output.
- **Session orchestration.** The kernel owns root sessions, child sessions, lifecycle events, sync runs, async runs, and canonical run envelopes.
- **Replaceable capabilities.** Storage, queueing, logging, terminal tools, file tools, web tools, MCP, Agent Skills, delegation, interaction, messaging, memory, output, and Hono live in plugins rather than the kernel.
- **Durability.** The starter stack includes SQLite-backed storage, queue-backed async execution, durable messaging, and file-backed memory.
- **Embedding surface.** The Hono plugin and starter preset provide a service-oriented path for apps that need HTTP transport instead of only an interactive terminal.
- **Operational shape.** The repo carries package ownership rules, contract artifacts, generated docs checks, CI gates, release conventions, security docs, and sandboxed terminal execution.

## What Generic AI Does Not Try To Own

Generic AI should stay honest about its boundary.

It does not try to replace `pi`'s low-level model/provider and tool-call mechanics. It should expose `pi` primitives directly where that improves plugin ergonomics.

For OpenAI Codex inference, Generic AI uses Pi's `openai-codex` provider method:
Pi auth/model resolution plus `AgentSession` execution. The framework does not
maintain a separate direct OpenAI client path for the default Codex adapter.

It does not make TUI or web UI part of the kernel. Those are deferred framework tracks. A product can still build UI on top of Generic AI, and it can use `pi` UI packages where those fit.

It does not put MCP, Agent Skills, delegation, messaging, memory, terminal tools, file tools, or output shaping into the kernel. Those stay plugin-owned so the framework can evolve without locking every app into one business model.

It does not inherit the full old Generic Corp product surface. Generic AI is a public framework reimplementation with a minimal kernel and replaceable capability packages.

## Design Boundary

The intended stack is:

```text
Apps, services, products
          |
          v
Generic AI presets/transports
starter-hono, Hono routes
          |
          v
Generic AI kernel and SDK
plugin host, scope, sessions
          |
          v
Generic AI plugins
tools, MCP, skills, memory
          |
          v
pi
model/runtime/tool mechanics
```

The clean mental model: `pi` is the low-level runtime layer; Generic AI is the composition and application-framework layer that lets teams swap capabilities without redesigning the whole system.

## Contributor Rules

Keep these rules intact when changing the framework:

- Build on top of `pi`; do not fork it.
- Expose `pi` primitives directly where practical.
- Keep the kernel minimal.
- Put business capabilities in plugins.
- Make plugins depend on `@generic-ai/sdk`, not `@generic-ai/core`.
- Let presets compose the kernel and plugins.
- Update docs when a change affects public behavior, package ownership, configuration, or operational expectations.

Related source-of-truth docs:

- [`docs/planning/01-scope-and-decisions.md`](planning/01-scope-and-decisions.md)
- [`docs/planning/02-architecture.md`](planning/02-architecture.md)
- [`docs/package-boundaries.md`](package-boundaries.md)
