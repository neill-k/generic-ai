# Scope And Decisions

## Purpose

This document captures the decisions made during discovery so the architecture and issue tree can be reviewed against a fixed baseline.

## Audience

Planning should optimize for long-term maintainability and eventual public usability, but the first consumer is internal.

## Authoritative Inputs

These inputs are treated as normative during planning:

- Repo entrypoint: [README.md](../../README.md)
- Active planning baseline: this document plus `02-architecture.md`, `03-linear-issue-tree.md`, and `04-agent-ready-mapping.md`
- `pi`/`pi-mono`: [pi-mono repository](https://github.com/badlogic/pi-mono)
- Agent Skills: [specification](https://agentskills.io/specification) and [client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)
- Hono: [documentation](https://hono.dev/)
- MCP: [Model Context Protocol docs](https://modelcontextprotocol.io/)
- Agent readiness baseline: [agent-ready repository](https://github.com/robotlearning123/agent-ready/tree/main)

Anything outside that baseline should be treated as non-authoritative for reimplementation planning unless it is explicitly promoted into the planning pack.


## Core Product Decision

This is a framework reimplementation, not a reimplementation of the full Generic Corp product.

The framework should preserve the useful architectural lessons from the old system, but it should not inherit the full product surface area by default.

## Kernel Decision

The kernel stays minimal.

The kernel owns:

- plugin host and lifecycle
- plugin dependency ordering
- registries and composition surfaces
- bootstrap path
- scope primitive
- execution session orchestration
- child session lifecycle and result collection
- streaming event model
- sync and async run handling
- canonical run envelope
- config discovery, validation, and composition

The kernel does not own most business capabilities directly.

## `pi` Decision

Use `pi` as the underlying agent/tool runtime foundation.

Planning assumptions:

- build on top of `pi`, do not fork it
- expose `pi` primitives directly where practical
- avoid rebuilding low-level tool and message primitives unnecessarily
- keep an internal adapter layer around runtime/bootstrap wiring so the system can evolve later without a repo-wide redesign

## Working Definition Of V1

V1 counts as a working multi-agent framework when the standard path can do the following:

1. A caller submits either a plain prompt or structured task input.
2. A primary agent starts a streaming run.
3. That agent can delegate work to child agents.
4. Those agents can use tools.
5. The toolbelt includes local terminal tools, local file tools, MCP, and Agent Skills.
6. Messaging between agents is durable.
7. Agent memory is persistent, file-backed, and searchable.
8. The run can complete synchronously or via a queue-backed asynchronous path.
9. The framework returns a canonical run envelope plus plugin-defined output.

## Required Base Plugins For The First Planning Wave

These are the required base-plugin families in scope for the first detailed implementation plan:

- config
- workspace
- storage
- queue
- logging with OTEL support
- terminal tools
- file tools
- MCP
- Agent Skills
- delegation
- messaging
- memory
- output formatting/finalization

Also included in the first planning wave:

- Hono as an official base plugin
- a starter preset that includes Hono by default

## Plugin Ownership Decisions

These capabilities are intentionally plugin-owned, not kernel-owned:

- MCP
- Agent Skills
- delegation model
- messaging model
- memory implementation
- terminal tools
- file tools
- output rendering/finalization

The kernel should orchestrate sessions around them, but those capabilities remain replaceable.

## Agent Model Decisions

- agents are mostly plugin-defined
- agents can be declared in config and created dynamically at runtime
- dynamically created agents are ephemeral unless a plugin persists them
- the starter path should support one primary agent and dynamic creation of additional agents

## Configuration Decisions

- config is canonical, not ad hoc
- config schemas must be machine-readable and composable
- config lives in multiple files by concern
- the layout is canonical
- the file format is YAML
- v1 should use a single resolved config layer, not layered overrides
- config files live in the repo/workspace, not primarily in env vars or programmatic-only setup

## Storage And Workspace Decisions

- storage has one contract and multiple implementations
- phase 1 should include in-memory storage and SQLite storage
- Postgres is deferred
- workspace is local-filesystem-first
- the framework should ship a recommended workspace layout, but plugins are not forced to follow every path choice

## Tooling Decisions

- local terminal access is required in v1
- local file operations are required in v1
- both should ship as standard base plugins
- both should be exposed as `pi` tools
- both start unrestricted for local workspace use in v1
- terminal tools and file tools should be split into separate plugins

## Messaging, Memory, And Delegation Decisions

- messaging is required in v1
- messaging must be durable
- messaging should be storage-backed in v1
- memory is required in v1
- memory should support persistent read/write/search
- memory should be file-backed in v1
- delegation should stay KISS and remain plugin-defined
- the kernel still owns child-session lifecycle and result collection
- the kernel should emit standard session/delegation lifecycle events

## Streaming And Output Decisions

- streaming is mandatory in v1
- both sync and async execution paths are required
- both execution paths should share the same kernel session machinery
- the kernel should return a minimal canonical run envelope
- final output shaping belongs to plugins

## Starter Preset Decisions

- ship a starter preset
- the top-level bootstrap should default to that preset
- the starter preset should include Hono by default
- the starter preset should optimize for "it works" over custom assembly

## Repo-Control And Compliance Decisions

- the first Linear plan should include technical and non-technical repo-control work
- include docs, contribution rules, ownership/boundaries, CI gates, and docs-as-code
- the `agent-ready` work should be represented in the Linear plan
- not every `agent-ready` item has to be implemented in the first coding phase
- some checks may be satisfied later, including via non-code repo/org settings when appropriate

## What Is Explicitly Deferred

These areas should exist in the roadmap, but not in the first detailed implementation push:

- identity/auth
- governance and security policy runtime
- richer observability surfaces beyond the base OTEL/logging path
- Postgres storage
- BullMQ or external queueing
- TUI
- web UI
- economy/reputation
- federation
- compounding/learning loops
- product-specific org chart, board, and enterprise control planes

The concrete resumption plan for the deferred runtime-governance/security track
now lives in [`docs/runtime-governance.md`](../runtime-governance.md).
The concrete resumption plan for the deferred advanced-observability track now
lives in [`docs/advanced-observability.md`](../advanced-observability.md).

## Planning Rule For Linear Issues

Every implementation issue should explicitly tell the assignee to:

- research relevant current best practices on the internet before coding
- record major decisions and trade-offs inside Linear
- also record major decisions and trade-offs within docs/decisions/
- update docs/contracts/examples when those decisions affect the public framework shape
