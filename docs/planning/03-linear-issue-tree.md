# Linear Issue Tree

## Project Shape

Recommended Linear project: `Generic AI Framework Reimplementation`

Planning assumptions:

- one Linear project
- no estimates in the first pass
- issue dependencies are explicit
- sub-issues should be directly executable
- every issue should instruct the implementer to research current best practices and record decisions in Linear before coding

## Global Instruction Block For Every Issue

Add this intent to every implementation issue:

1. Research relevant current best practices, library guidance, and examples before implementation.
2. Record the chosen approach and notable rejected alternatives in Linear before coding.
3. Update affected docs, contracts, examples, and tests as part of the same issue.

## Default Issue Body Template

Unless a specific issue needs something more specialized, each Linear issue should contain these sections:

- `Why`: what capability or control surface this issue unlocks
- `Research`: which external docs/libs/specs must be checked before coding
- `Deliverables`: concrete code/docs/tests/config outputs
- `Verification`: exact commands or checks that prove the issue is done
- `Decision Log`: a short note recorded back into Linear with chosen approach and trade-offs

## Default Implementation Expectations

Unless explicitly excluded, every implementation issue should also require:

- package-level README or doc updates if public behavior changes
- tests at the right layer for the change
- example/config updates if the starter preset is affected
- contract updates if plugin or kernel interfaces change

## Epic 0: Planning, Source Of Truth, And Repo Scaffolding

### `FND-01` Establish the authoritative planning baseline

Depends on: none

Acceptance criteria:

- repo contains authoritative planning docs
- old/new source-of-truth status is explicit
- Linear import order is documented

### `FND-02` Scaffold the monorepo structure

Depends on: `FND-01`

Acceptance criteria:

- repo layout matches planned architecture
- package boundaries are documented
- examples and plugins have clear homes

### `FND-03` Establish the base toolchain

Depends on: `FND-02`

Acceptance criteria:

- workspace scripts exist for build, test, typecheck, lint, docs
- local contributor path is documented
- toolchain decision record exists

### `FND-04` Set up release and package publishing conventions

Depends on: `FND-03`

Acceptance criteria:

- package versioning approach is documented
- release automation direction is documented
- public-vs-internal package assumptions are explicit

## Epic 1: SDK And Kernel

### `KRN-01` Define SDK contracts for plugins, registries, and lifecycle

Depends on: `FND-03`

Acceptance criteria:

- plugin authors can implement against typed contracts
- lifecycle and dependency rules are testable
- contracts are documented and covered by contract tests where applicable

### `KRN-02` Implement the plugin host and dependency ordering

Depends on: `KRN-01`

Acceptance criteria:

- host loads plugins deterministically
- dependency failures are surfaced clearly
- lifecycle order is tested

### `KRN-03` Define and implement the `Scope` primitive

Depends on: `KRN-01`

Acceptance criteria:

- scope is available from bootstrap through plugin execution
- scope stays generic and not tenant-specific
- scope behavior is documented

### `KRN-04` Implement kernel session orchestration

Depends on: `KRN-02`, `KRN-03`

Acceptance criteria:

- kernel can manage root and child sessions
- child sessions are observable independently and from the parent
- success/failure/cancellation paths are tested

### `KRN-05` Implement the canonical event stream

Depends on: `KRN-04`

Acceptance criteria:

- event model supports streaming-first execution
- plugins can subscribe without private kernel hooks
- event taxonomy is documented

### `KRN-06` Implement sync and async run modes on shared session machinery

Depends on: `KRN-04`, `KRN-05`

Acceptance criteria:

- both modes use the same session model
- async scheduling is pluggable
- mode-specific behavior is covered by tests

### `KRN-07` Define the minimal canonical run envelope

Depends on: `KRN-05`, `KRN-06`

Acceptance criteria:

- kernel returns a stable envelope without owning final payload semantics
- output plugin hook is explicit
- envelope is documented and test-covered

### `KRN-08` Integrate `pi` directly and document the direct-exposure boundary

Depends on: `KRN-01`, `KRN-04`

Acceptance criteria:

- developers know which types come directly from `pi`
- the framework avoids needless wrapper churn
- the internal adapter boundary is documented

### `KRN-09` Implement the top-level bootstrap API

Depends on: `KRN-02`, `KRN-06`, `KRN-07`, `KRN-08`

Acceptance criteria:

- a user can bootstrap the framework through one obvious entrypoint
- the starter preset is the default path
- advanced users can override composition explicitly

## Epic 2: Config And Presets

### `CFG-01` Define canonical YAML config schemas by concern

Depends on: `KRN-01`

Acceptance criteria:

- framework, agent, plugin, and preset config schemas are defined
- schemas are machine-readable and composable
- schema boundaries are documented

### `CFG-02` Implement canonical config discovery and resolution

Depends on: `CFG-01`, `KRN-09`

Acceptance criteria:

- `.generic-ai/` discovery works deterministically
- multiple files by concern resolve into one final config object
- config load failures are actionable

### `CFG-03` Implement config validation and plugin schema composition

Depends on: `CFG-01`, `CFG-02`

Acceptance criteria:

- plugins can register schema fragments
- validation runs before framework startup completes
- invalid config is blocked with useful diagnostics

### `CFG-04` Build the starter preset contract

Depends on: `KRN-09`, `CFG-02`

Acceptance criteria:

- starter preset is a first-class package/contract
- starter preset can be loaded by the top-level bootstrap API
- custom preset extension points are documented

## Epic 3: Infrastructure Base Plugins

### `INF-01` Build `plugin-workspace-fs`

Depends on: `KRN-01`, `CFG-03`

Acceptance criteria:

- workspace services support the needed local filesystem operations
- recommended workspace layout helpers exist
- file-backed plugins can depend on this package cleanly

### `INF-02` Build `plugin-storage-memory`

Depends on: `KRN-01`, `CFG-03`

Acceptance criteria:

- storage contract has a working in-memory implementation
- automated tests can use it without external dependencies
- behavior matches the shared storage contract

### `INF-03` Build `plugin-storage-sqlite`

Depends on: `INF-02`, `CFG-03`

Acceptance criteria:

- SQLite is the durable local storage implementation
- init/bootstrap behavior is documented
- storage-backed plugins can persist state locally

### `INF-04` Build `plugin-queue-memory`

Depends on: `KRN-06`, `CFG-03`

Acceptance criteria:

- async execution works in-process without external infrastructure
- queue behavior integrates with shared session machinery
- replacement path for future external queues stays clean

### `INF-05` Build `plugin-logging-otel`

Depends on: `KRN-05`, `CFG-03`

Acceptance criteria:

- kernel session events can be logged and traced
- OTEL export support exists from day one
- instrumentation path is documented for plugin authors

### `INF-06` Build `plugin-output-default`

Depends on: `KRN-07`, `CFG-03`

Acceptance criteria:

- starter preset has a default output/finalization behavior
- output formatting is pluggable rather than kernel-owned
- replacement path is documented

## Epic 4: Local Capability Base Plugins

### `CAP-01` Build `plugin-tools-terminal`

Depends on: `INF-01`, `CFG-03`, `KRN-08`

Acceptance criteria:

- agents can execute local commands through shipped `pi` tools
- tools are documented and tested
- unrestricted-local default is explicit in docs

### `CAP-02` Build `plugin-tools-files`

Depends on: `INF-01`, `CFG-03`, `KRN-08`

Acceptance criteria:

- agents can read/write/list/edit files through shipped `pi` tools
- tools integrate with workspace services
- starter preset wiring is covered by tests

### `CAP-03` Build `plugin-mcp`

Depends on: `KRN-08`, `CFG-03`

Acceptance criteria:

- MCP works as a replaceable plugin rather than a kernel hard dependency
- starter preset can use MCP out of the box
- integration path is documented and tested

### `CAP-04` Build `plugin-agent-skills`

Depends on: `INF-01`, `CFG-03`

Acceptance criteria:

- plugin follows the public Agent Skills spec
- project/user/global skill discovery strategy is implemented
- progressive disclosure behavior is documented and tested

### `CAP-05` Build `plugin-delegation`

Depends on: `KRN-04`, `KRN-05`, `CFG-03`

Acceptance criteria:

- a root agent can delegate work to child agents
- plugin defines delegation semantics while kernel owns session lifecycle
- parent-child execution path is demonstrated in tests or example flows

### `CAP-06` Build `plugin-messaging`

Depends on: `INF-03`, `CFG-03`

Acceptance criteria:

- durable storage-backed messaging works across runs
- agents can exchange messages independently of a single in-memory session
- messaging shape is documented

### `CAP-07` Build `plugin-memory-files`

Depends on: `INF-01`, `CFG-03`

Acceptance criteria:

- memory is file-backed
- memory supports persistent read/write/search
- memory file layout and retrieval behavior are documented

### `CAP-08` Build `plugin-tools-web`

Depends on: `INF-01`, `KRN-08`

Acceptance criteria:

- `plugin-tools-web` exists under `packages/`
- agents can fetch HTTP(S) content through a shipped tool with text normalization
- agents can run provider-backed web search through a configurable interface
- shared hostname allow/block rules apply to both fetches and search results
- the plugin is documented and covered by unit tests

## Epic 5: Transport, Starter Preset, And Reference Example

### `TRN-01` Build `plugin-hono`

Depends on: `KRN-09`, `CFG-03`, `KRN-05`

Acceptance criteria:

- Hono works as an official optional plugin
- Hono can carry streaming runs cleanly
- the starter preset can include Hono by default without making core transport-bound

### `TRN-02` Assemble the starter preset

Depends on: `CFG-04`, `INF-01` through `INF-06`, `CAP-01` through `CAP-07`, `TRN-01`

Acceptance criteria:

- preset composes the planned local-first working stack
- preset includes Hono by default
- preset is documented as the default onboarding path

### `TRN-03` Build a reference example that proves the whole stack

Depends on: `TRN-02`

Acceptance criteria for `TRN-03`:

- example demonstrates prompt or structured task input
- example demonstrates streaming, delegation, messaging, memory, MCP, and skills
- example is used in docs and verification

## Epic 6: Agent-Ready And Repo Control Plane

### `CTL-01` Build the baseline repository docs

Depends on: `FND-03`

Acceptance criteria:

- repo has baseline contributor/agent/source-of-truth docs
- docs reflect framework reality rather than the old product spec
- docs structure supports future docs-as-code and generated docs work

### `CTL-02` Build CI, verification, and branch-control foundations

Depends on: `FND-03`

Acceptance criteria:

- CI runs the repo quality gates
- required checks strategy is documented
- branch-control expectations are explicit

### `CTL-03` Build agent boundaries, ownership, and task discovery controls

Depends on: `CTL-01`

Acceptance criteria:

- boundaries and ownership are represented in repo files
- issue and PR templates exist
- task-discovery path for humans and agents is documented

### `CTL-04` Build docs-as-code and generated API docs

Depends on: `FND-03`, `KRN-01`

Acceptance criteria:

- generated API docs path exists
- docs build/update flow is automated
- docs publication/update expectations are documented

### `CTL-05` Build advanced test discipline

Depends on: `FND-03`, `KRN-01`

Acceptance criteria:

- contract-testing approach exists
- coverage policy exists
- mutation/property testing path is explicitly planned even if partially deferred

### `CTL-06` Build security and software-supply-chain controls

Depends on: `FND-03`

Acceptance criteria:

- CODEOWNERS, dependency update, and baseline security hygiene are planned in repo
- deferred SAST/SBOM work remains tracked
- secret-handling expectations are documented

### `CTL-07` Build code-quality governance

Depends on: `FND-03`

Acceptance criteria:

- technical debt tracking path exists
- quality/duplication/complexity tooling direction is documented
- quality controls are represented in the roadmap

## Epic 7: Deferred But Planned Tracks

### `DEF-01` Plan the identity/auth plugin

Depends on: `TRN-02`

Acceptance criteria:

- auth/plugin boundary is documented
- Hono integration implications are called out

### `DEF-02` Plan Postgres storage

Depends on: `INF-03`

Acceptance criteria:

- migration path from SQLite is documented
- storage-contract implications are explicit

### `DEF-03` Plan external queueing

Depends on: `INF-04`

Acceptance criteria:

- future BullMQ or equivalent plugin path is documented
- async contract changes are minimized

### `DEF-04` Plan governance and runtime security controls

Depends on: `KRN-05`, `CAP-01`, `CAP-02`, `CAP-03`

Implementation note: the concrete roadmap produced by this issue lives in
`docs/runtime-governance.md`.

Acceptance criteria:

- policy/runtime-enforcement surfaces are mapped
- terminal/file/MCP hardening path is explicit

### `DEF-05` Plan TUI and web UI tracks

Depends on: `TRN-02`

Acceptance criteria:

- UI work is framed as consumer layers, not kernel blockers
- relationship to `pi` and Hono is documented

### `DEF-06` Plan advanced observability beyond OTEL baseline

Depends on: `INF-05`

Acceptance criteria:

- richer dashboards/analytics remain in roadmap
- baseline OTEL support stays separate from product-grade observability

## Linear Import Order

When creating or resyncing this issue tree in Linear, import issues in this order:

1. `FND-01` through `FND-04`
2. `KRN-01` through `KRN-09`
3. `CFG-01` through `CFG-04`
4. `INF-01` through `INF-06`
5. `CAP-01` through `CAP-08`
6. `TRN-01` through `TRN-03`
7. `CTL-01` through `CTL-07`
8. `DEF-01` through `DEF-06`

Within each epic, preserve the written order so dependency links can be created cleanly as the issues are entered.

## Suggested Initial Implementation Order

1. `FND-01` to `FND-04`
2. `KRN-01` to `KRN-09`
3. `CFG-01` to `CFG-04`
4. `INF-01` to `INF-06`
5. `CAP-01` to `CAP-08`
6. `TRN-01` to `TRN-03`
7. `CTL-01` to `CTL-07`
8. `DEF-01` to `DEF-06`

## Minimum "It Works" Milestone

The first meaningful milestone should require:

- bootstrap through the default starter preset
- Hono included
- prompt or structured task input
- streaming run execution
- dynamic child-agent delegation
- file tools and terminal tools
- MCP support
- Agent Skills support
- durable messaging
- file-backed memory with search
- both sync and async execution paths
- a runnable reference example
