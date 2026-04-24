# Generic AI Framework

Pluggable, extensible multi-agent framework.

Generic AI is a plugin-first framework reimplementation. The goal is a clean public framework with a minimal kernel and replaceable capability plugins.

## Current Planning Baseline

The authoritative planning baseline for this repository is:

1. [`docs/planning/README.md`](docs/planning/README.md)
2. [`docs/planning/01-scope-and-decisions.md`](docs/planning/01-scope-and-decisions.md)
3. [`docs/planning/02-architecture.md`](docs/planning/02-architecture.md)
4. [`docs/planning/03-linear-issue-tree.md`](docs/planning/03-linear-issue-tree.md)
5. [`docs/planning/04-agent-ready-mapping.md`](docs/planning/04-agent-ready-mapping.md)

Use that set for scope, architecture, sequencing, and Linear sync decisions.

Notes elsewhere in the repo are not planning source-of-truth material unless they are explicitly linked from that planning pack.

## Repository Layout

- `packages/` — framework source. Holds `@generic-ai/core`, `@generic-ai/sdk`, every base plugin, and the starter preset. One directory per package.
- `examples/` — runnable reference usage of the framework. `examples/starter-hono/` is the `TRN-03` reference example that exercises the full starter stack.
- `contracts/` — frozen interface contracts produced by kernel and config work (KRN-01, CFG-01, and later).
- `specs/` — specifications consumed by docs-as-code and contract-testing workflows.
- `docs/` — the planning pack, architecture decision records, and framework documentation.

See [`docs/package-boundaries.md`](docs/package-boundaries.md) for the authoritative package ownership map, layering rules, and per-package responsibilities. The monorepo scaffold itself is captured in [`docs/decisions/0001-monorepo-scaffold.md`](docs/decisions/0001-monorepo-scaffold.md).

## Toolchain

Generic AI uses a single shared toolchain for every package in the workspace:

- Node 24 LTS (pinned via [`.nvmrc`](.nvmrc) and `engines.node`).
- npm 11 workspaces (pinned via `packageManager`).
- TypeScript 6 with project references (`tsc -b`) and strict compiler settings in [`tsconfig.base.json`](tsconfig.base.json).
- Biome 2.4 for linting and formatting, configured in [`biome.json`](biome.json).
- Vitest 4 for tests, configured in [`vitest.config.ts`](vitest.config.ts).

The four-command quality gate:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Every contributor runs the same four commands locally before opening a pull request. The [`baseline-quality-gate`](.github/workflows/baseline-quality-gate.yml) workflow runs the same gate on pull requests and pushes to `main`; the required branch-protection settings live in [`docs/branch-protection.md`](docs/branch-protection.md). Full contributor setup, per-command reference, and how to add new packages live in [`CONTRIBUTING.md`](CONTRIBUTING.md). The toolchain decisions and trade-offs are recorded in [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md).

## Releases

Generic AI uses [Changesets](https://github.com/changesets/changesets) for independent per-package semver, automated changelog generation, and npm publishing. Every publishable package under `packages/*` is scoped `@generic-ai/*` and ships with `publishConfig.access: "public"` plus `publishConfig.provenance: true`. The full release playbook (versioning rules, public-vs-internal classification, and the manual-until-CTL-02 cut path) lives in [`RELEASING.md`](RELEASING.md). The release-tool decision, trade-offs, and rejected alternatives are recorded in [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md). PRs that touch any publishable package should include a changeset — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the one-line recipe.

## Implementation Status

The framework's first functional vertical slice is landed on `main`. The "Minimum It Works" milestone from [`docs/planning/03-linear-issue-tree.md`](docs/planning/03-linear-issue-tree.md) is met: a caller can bootstrap through the starter preset, get Hono transport by default, run streaming sync or async, delegate to child agents, read/write files and execute terminal commands through shipped `pi` tools, reach MCP servers, load Agent Skills, exchange durable messages, and read/write file-backed memory with search.

### Epics complete

| Epic | Scope | Status |
| --- | --- | --- |
| 0 — Planning & scaffolding (`FND-01`..`FND-04`) | Planning baseline, monorepo scaffold, toolchain, release conventions | Done |
| 1 — SDK & kernel (`KRN-01`..`KRN-09`) | Plugin contracts, host, `Scope`, session orchestration, canonical event stream, run envelope, bootstrap API | Done |
| 2 — Config & presets (`CFG-01`..`CFG-04`) | Canonical YAML schemas, discovery/resolution, plugin schema composition, starter preset contract | Done |
| 3 — Infrastructure base plugins (`INF-01`..`INF-06`) | Workspace FS, memory + SQLite storage, in-process queue, OTEL logging, default output | Done |
| 4 — Local capability base plugins (`CAP-01`..`CAP-09`) | Terminal, file, and web tools; MCP; Agent Skills; delegation; messaging; file-backed memory; blocking user interaction | Done |
| 5 — Transport, starter preset, reference example (`TRN-01`..`TRN-03`) | `plugin-hono`, assembled starter preset, runnable `examples/starter-hono` | Done |
| 6 — Agent-ready and repo control plane (`CTL-01`..`CTL-07`) | Contributor/agent docs, ownership, issue/PR templates, CI, docs-as-code, security baseline, quality-governance roadmap | Done |
| 8 — Runtime integration (`RT-01`..`RT-06`) | Composed plugin-host startup, YAML-driven session construction, real provider inference, Hono routes calling the composed runtime, live provider smoke test, Node/install parity | Done |
| 9 — Sandboxed code execution (`SBX-02`..`SBX-10`) | `SandboxContract` in SDK, Docker-backed `plugin-tools-terminal-sandbox` with resource/network/file policy, output capture, starter preset wiring, integration tests, operator docs | Done |

### Planning-only tracks complete

`DEF-04` (runtime governance roadmap), `DEF-05` (TUI / web UI tracks), and `DEF-07` (sandboxed execution research) landed as planning ADRs and roadmap docs.

### In flight

The remaining Epic 7 deferred tracks (`DEF-01` identity/auth, `DEF-02` Postgres storage, `DEF-03` external queueing, `DEF-06` advanced observability) are still in the backlog. Sandbox plugin P2 hardening follow-ups are tracked in `NEI-383`.

## Shipped Packages

All packages live under `packages/` and publish as `@generic-ai/*`.

### Framework core

- [`@generic-ai/core`](packages/core) — kernel: bootstrap, plugin host, registries, `Scope`, session orchestration, streaming events, canonical run envelope.
- [`@generic-ai/sdk`](packages/sdk) — framework-facing SDK contracts and typed helpers that plugins and presets depend on.

### Infrastructure plugins

- [`@generic-ai/plugin-workspace-fs`](packages/plugin-workspace-fs) — local filesystem workspace services and layout helpers.
- [`@generic-ai/plugin-storage-memory`](packages/plugin-storage-memory) — in-memory storage for tests and fast local iteration.
- [`@generic-ai/plugin-storage-sqlite`](packages/plugin-storage-sqlite) — durable SQLite-backed storage; default for the starter preset.
- [`@generic-ai/plugin-queue-memory`](packages/plugin-queue-memory) — in-process queue providing the async execution path.
- [`@generic-ai/plugin-logging-otel`](packages/plugin-logging-otel) — structured logging and OpenTelemetry tracing over kernel session events.
- [`@generic-ai/plugin-output-default`](packages/plugin-output-default) — default final-response shaping, kept out of the kernel.
- [`@generic-ai/plugin-config-yaml`](packages/plugin-config-yaml) — canonical YAML config discovery, validation, and resolution.

### Capability plugins

- [`@generic-ai/plugin-tools-terminal`](packages/plugin-tools-terminal) — local command execution as a shipped `pi` tool (host execution, no isolation).
- [`@generic-ai/plugin-tools-terminal-sandbox`](packages/plugin-tools-terminal-sandbox) — Docker-backed terminal execution with per-session containers, resource ceilings, timeout enforcement, network policy modes, file bridge, and structured output capture. Opt-in via `GENERIC_AI_SANDBOX=docker` on the starter preset.
- [`@generic-ai/plugin-tools-files`](packages/plugin-tools-files) — local file read/write/list/edit `pi` tools.
- [`@generic-ai/plugin-tools-web`](packages/plugin-tools-web) — configurable web fetch/search tools with shared host allow/block policies.
- [`@generic-ai/plugin-mcp`](packages/plugin-mcp) — Model Context Protocol support as a replaceable plugin.
- [`@generic-ai/plugin-agent-skills`](packages/plugin-agent-skills) — Agent Skills compatibility with progressive disclosure.
- [`@generic-ai/plugin-delegation`](packages/plugin-delegation) — delegation business model; kernel retains child-session lifecycle.
- [`@generic-ai/plugin-interaction`](packages/plugin-interaction) — blocking user questions plus visible task-list publishing through standard `pi` tools.
- [`@generic-ai/plugin-messaging`](packages/plugin-messaging) — durable, storage-backed inter-agent messaging.
- [`@generic-ai/plugin-memory-files`](packages/plugin-memory-files) — file-backed persistent agent memory with search.

### Transport and preset

- [`@generic-ai/plugin-hono`](packages/plugin-hono) — Hono integration; optional but included in the starter preset by default.
- [`@generic-ai/preset-starter-hono`](packages/preset-starter-hono) — starter preset contract that composes the default local-first stack, including Hono.

### Reference example

- [`examples/starter-hono`](examples/starter-hono) — runnable example that proves the whole stack: `createGenericAI()` with no arguments resolves the built-in starter descriptor, and callers can also pass `createStarterHonoPreset()` explicitly.

## Sandbox Execution Docs

The sandbox stack has its own operator and API docs pack:

- [`docs/sandbox/README.md`](docs/sandbox/README.md) — overview and entry points
- [`docs/sandbox/plugin-api-reference.md`](docs/sandbox/plugin-api-reference.md) — public SDK and plugin contract surface
- [`docs/sandbox/operator-guide.md`](docs/sandbox/operator-guide.md) — prerequisites, enablement, verification, and troubleshooting
- [`docs/sandbox/migration-guide.md`](docs/sandbox/migration-guide.md) — step-by-step move from unrestricted host execution to sandbox execution
- [`docs/sandbox/security-model.md`](docs/sandbox/security-model.md) — protections, limitations, and deployment posture
- [`docs/decisions/0013-sandboxed-execution.md`](docs/decisions/0013-sandboxed-execution.md) — repo-level decision and alternatives considered

## Roadmap

Remaining tracked work:

- **Epic 7 - Deferred but planned tracks:** `DEF-01` identity/auth plugin, `DEF-02` Postgres storage, `DEF-03` external queueing, `DEF-06` advanced observability beyond the OTEL baseline. Runtime governance posture is captured in [`docs/runtime-governance.md`](docs/runtime-governance.md).
- **Sandbox plugin P2 hardening (`NEI-383`):** DNS-rebinding defense in the allowlist proxy, proxy readiness probe, writable-rootfs tightening, and the rest of the deferred bot findings from the NEI-372 rollup.

See [`docs/planning/03-linear-issue-tree.md`](docs/planning/03-linear-issue-tree.md) for full scope and dependency links.
