# Architecture

## Design Summary

The planned system is a plugin-first multi-agent framework built on top of `pi`.

`pi` provides the underlying agent/tool runtime mechanics. `Generic AI` provides the framework shell that aims to scale the composability to a large number of agents, while added useful, opinionated defaults.

The framework should represent an easy-to-use, but hackable surface for multi-agent coordination and eperimentation.

## High-Level Shape

```text
+--------------------------------------------------------------+
| @generic-ai/core            |
| --------------------------- |
| bootstrap                   | plugin host     | registries   | scope        |
| sessions                    | child runs      | event stream | run envelope |
| config discovery/validation | preset assembly |
+--------------------------------------------------------------+
                 | uses
                 v
+--------------------------------------------------------------+
| pi / pi-mono |
| ------------ |
| agent loop   | tool calling | streaming | model/runtime glue |
+--------------------------------------------------------------+
                 | extended by
                 v
+--------------------------------------------------------------+
| @generic-ai base plugins |
| ------------------------ |
| config                   | workspace  | storage | queue  | logging/otel |
| terminal tools           | file tools | mcp     | skills | delegation   |
| messaging                | memory     | output  | hono   |
+--------------------------------------------------------------+
                 | bundled by
                 v
+--------------------------------------------------------------+
| @generic-ai/preset-starter-hono                            |
| ---------------------------------------------------------- |
| a default working stack with sensible local-first defaults |
+--------------------------------------------------------------+
```

## Kernel Responsibilities

The kernel should own the framework control plane, not the business capabilities.

### Bootstrap

- provide one top-level entrypoint such as `createGenericAI()`
- load the starter preset by default
- support explicit custom plugin composition for advanced usage

### Plugin Host

- register plugins
- validate manifests
- order dependencies
- run lifecycle hooks
- expose plugin registries
- keep plugin contracts machine-checkable

### Scope

- define a first-class `Scope` concept now
- keep it generic enough to outlive any single tenancy model
- use it as the common execution context boundary for runs, plugins, and config

### Sessions And Runs

- create root execution sessions
- allow child-session creation
- own child-session lifecycle tracking
- collect child terminal states and outputs
- support synchronous and queued execution with one shared session model

### Streaming Events

- emit a canonical stream for run/session lifecycle
- include child-session/delegation lifecycle visibility
- support OTEL/logging plugins without forcing output schema decisions into the kernel

### Canonical Run Envelope

The kernel should return a small stable envelope and leave payload shape to plugins.

Recommended envelope shape:

- run id
- root scope id
- root agent id
- execution mode
- status
- timestamps
- event stream handle/reference
- output plugin id
- plugin-defined output payload

## Kernel Non-Responsibilities

These should stay out of the kernel:

- a canonical task model
- a canonical delegation business model
- a canonical messaging model
- a canonical memory schema beyond the minimum interfaces needed by plugins
- a canonical tool schema beyond what is inherited directly from `pi`
- product-specific admin, governance, or enterprise workflows

## Package Layout

Recommended repo shape:

```text
packages/
  core/
  sdk/
  preset-starter-hono/
  plugin-config-yaml/
  plugin-workspace-fs/
  plugin-storage-memory/
  plugin-storage-sqlite/
  plugin-queue-memory/
  plugin-logging-otel/
  plugin-tools-terminal/
  plugin-tools-files/
  plugin-mcp/
  plugin-agent-skills/
  plugin-delegation/
  plugin-messaging/
  plugin-memory-files/
  plugin-output-default/
  plugin-hono/
examples/
  starter-hono/
contracts/
specs/
docs/
  planning/
```

## SDK Responsibilities

`@generic-ai/sdk` should define the framework-facing contracts that plugins depend on.

Recommended contents:

- plugin manifest contract
- plugin lifecycle contract
- registry contracts
- config-schema contract
- scope contract
- storage contract
- workspace contract
- queue contract
- output-plugin contract
- typed helpers for writing plugins and presets

`pi` primitives should be re-exported where that materially improves plugin developer ergonomics.

## Required Base Plugins

### Required In The Working Stack

- `plugin-config-yaml`
- `plugin-workspace-fs`
- `plugin-storage-memory`
- `plugin-storage-sqlite`
- `plugin-queue-memory`
- `plugin-logging-otel`
- `plugin-tools-terminal`
- `plugin-tools-files`
- `plugin-mcp`
- `plugin-agent-skills`
- `plugin-delegation`
- `plugin-messaging`
- `plugin-memory-files`
- `plugin-output-default`

### Official But Optional

- `plugin-hono`

The starter preset should include Hono anyway, but the plugin itself remains optional at the framework level.

## Plugin Intent

### `plugin-config-yaml`

- load canonical YAML config files
- validate plugin config schemas
- produce a single resolved config object

### `plugin-workspace-fs`

- provide local filesystem workspace services
- back local file tools
- expose recommended workspace layout helpers

### `plugin-storage-memory`

- test and fast-local storage implementation

### `plugin-storage-sqlite`

- durable local storage implementation
- default local persistence path for the starter preset
- schema/init strategy

### `plugin-queue-memory`

- in-process queueing
- async execution path for local development and test coverage

### `plugin-logging-otel`

- structured logging
- trace emission
- OTEL export support from day one

### `plugin-tools-terminal`

- ship a standard `pi` tool for local command execution

### `plugin-tools-files`

- ship standard `pi` tools for reading/writing/listing/editing local files

### `plugin-mcp`

- provide embedded MCP support as a plugin, not a kernel hard requirement
- remain replaceable by alternate implementations

### `plugin-agent-skills`

- implement Agent Skills compatibility
- follow the public spec
- scan broad standard locations
- support progressive disclosure
- defer trust gating to a later version

### `plugin-delegation`

- provide a simple delegation capability first
- let the plugin define the business model
- rely on kernel child-session orchestration under the hood

### `plugin-messaging`

- durable inter-agent messaging
- storage-backed in v1

### `plugin-memory-files`

- file-backed persistent agent memory
- support read/write/search

### `plugin-output-default`

- provide a default output/finalization strategy
- keep final response shaping out of the kernel

### `plugin-hono`

- provide a Hono integration path for starter usage
- be included in the default preset

## Starter Preset

The starter preset should be the main way new users get to "it works."

Recommended preset behavior:

- wires up a local-first development stack
- includes Hono by default
- includes standard file and terminal tools
- includes MCP, Agent Skills, delegation, messaging, and memory
- uses SQLite for persistent storage
- uses the in-process queue for async execution
- exposes a simple programmatic bootstrap path plus a runnable example

## Canonical Config Layout

Config should be canonical, YAML-based, and split by concern.

Recommended v1 layout:

```text
.generic-ai/
  framework.yaml
  agents/
    primary.yaml
  plugins/
    config.yaml
    workspace.yaml
    storage.yaml
    queue.yaml
    logging.yaml
    terminal-tools.yaml
    file-tools.yaml
    mcp.yaml
    skills.yaml
    delegation.yaml
    messaging.yaml
    memory.yaml
    output.yaml
    hono.yaml
```

Rules:

- this is the canonical config discovery layout
- the system resolves one final config layer only
- plugins may own additional internal files, but the above layout is the documented default

## Recommended Workspace Layout

The framework should recommend a layout without forcing every plugin to adopt it.

Recommended v1 layout:

```text
.generic-ai/
  framework.yaml
  agents/
  plugins/
.agents/
  skills/
workspace/
  agents/
    <agent-id>/
      memory/
      results/
  shared/
```

Notes:

- `.agents/skills/` is recommended for cross-client compatibility with the Agent Skills ecosystem
- agent memory remains file-backed
- plugins may extend the workspace tree as needed

## Execution Modes

The same session machinery should support both modes:

- synchronous in-process runs
- queued/asynchronous runs

The queue plugin decides scheduling. The kernel decides how sessions are created, resumed, observed, and completed.

## Architecture Constraints

These constraints should be preserved while implementing:

- do not hide `pi` behind a heavy compatibility wrapper
- do not make Hono mandatory at the core layer
- do not put business features in the kernel just because the starter preset needs them
- do not make storage, messaging, memory, or MCP impossible to replace later

## Deferred Architecture Tracks

These should remain explicit roadmap items, but not phase-1 blockers:

- Postgres storage plugin
- BullMQ/external queue plugin
- identity/auth plugin
- governance/security runtime
- TUI
- web UI
- advanced observability surfaces
- richer durable agent/task/domain models
