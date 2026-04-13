# Package Boundaries And Ownership

This document maps every package in the Generic AI monorepo to its role, its allowed dependencies, and what it is intentionally not responsible for. It is the authoritative reference when a contributor is deciding where new code should live.

## Source Of Truth

- Planning baseline: `docs/planning/README.md` and `docs/planning/02-architecture.md`
- Scope and decisions: `docs/planning/01-scope-and-decisions.md`
- Monorepo scaffold decision record: `docs/decisions/0001-monorepo-scaffold.md`
- Base toolchain decision record: `docs/decisions/0002-base-toolchain.md`
- Release and publishing decision record: `docs/decisions/0003-release-and-publishing.md`
- Release playbook: `RELEASING.md`

When any of this document conflicts with the planning pack, the planning pack wins and this document should be updated to match.

## Top-Level Layout

```text
packages/            framework source: kernel, SDK, plugins, and the starter preset
examples/            runnable reference usage of the framework
contracts/           frozen interface contracts surfaced to plugin and external consumers
specs/               specifications used by docs-as-code and contract testing
docs/                planning pack, decision records, and framework documentation
```

## Layering Rules

Generic AI has a small number of layers. Dependency direction is strictly downward:

1. **Kernel** — `@generic-ai/core`
2. **SDK** — `@generic-ai/sdk`
3. **Plugins** — everything matching `@generic-ai/plugin-*`
4. **Presets** — `@generic-ai/preset-*`
5. **Examples** — `examples/*`

The layering rules:

- The kernel may depend on `pi` and on `@generic-ai/sdk` where that helps it expose its own contracts cleanly. It must not depend on any plugin or preset package.
- The SDK may depend on `pi`. It must not depend on the kernel or any plugin.
- Plugins may depend on `@generic-ai/sdk` and on `pi`. They must not import from `@generic-ai/core`. Plugins may depend on other plugins only when the dependency is part of the documented intent for that plugin (for example, `plugin-memory-files` and `plugin-tools-files` depending on `plugin-workspace-fs`, or `plugin-messaging` depending on a storage plugin through the storage contract rather than through a specific implementation whenever possible).
- Presets may depend on `@generic-ai/core`, `@generic-ai/sdk`, and any plugins they wire up. Presets are the only package type that is allowed to compose kernel and plugins together.
- Examples may depend on any public package they need to demonstrate framework usage. Examples must not be depended on by any package inside `packages/`.

Anything outside these rules needs an entry in `docs/decisions/` explaining the trade-off.

## Publishing And Visibility

Every directory under `packages/*` is a **public** package, published to npm under the `@generic-ai/` scope. Every directory under `examples/*` and the repo root itself are **internal**, never published. Decision record: `docs/decisions/0003-release-and-publishing.md`. Playbook: `RELEASING.md`.

- **Public (18 packages under `packages/*`).** Each carries `"private": false` plus `"publishConfig": { "access": "public", "provenance": true }` so the scoped package publishes publicly and requests an npm provenance attestation when published from a trusted CI environment. Versioning is independent per package via changesets.
- **Internal / never published.** The root `@generic-ai/monorepo` is `"private": true`. `examples/starter-hono/` (`@generic-ai/example-starter-hono`) is `"private": true` and additionally listed in `.changeset/config.json`'s `ignore` array. `contracts/` and `specs/` are top-level directories, not workspaces, and are not part of the npm publish surface. Any new workspace under `examples/*` inherits this private-by-default rule.

The per-package "Publishes as" field in each row below records this classification explicitly so contributors adding a new package have a template to copy.

## Package Matrix

Each row below captures the role, the allowed dependencies, the non-responsibilities, and the publishing classification for one package. "Allowed deps" lists layering rules, not concrete third-party libraries that individual packages may adopt later.

### `@generic-ai/core`

- Role: framework kernel. Owns bootstrap, plugin host, registries, scope, sessions, streaming events, and the canonical run envelope.
- Allowed deps: `pi`, `@generic-ai/sdk`.
- Not responsible for: MCP, Agent Skills, delegation, messaging, memory, storage implementations, transport, output shaping, or any business capability.
- Publishes as: `@generic-ai/core` — public, independent versioning, `publishConfig.access: public`, provenance on.

### `@generic-ai/sdk`

- Role: public framework-facing SDK. Defines the contracts plugin authors and preset authors compile against.
- Allowed deps: `pi`.
- Not responsible for: plugin implementations, config discovery, kernel internals.
- Publishes as: `@generic-ai/sdk` — public, independent versioning, `publishConfig.access: public`, provenance on.

### `@generic-ai/preset-starter-hono`

- Role: default starter preset. Composes the local-first working stack and is the path `createGenericAI()` loads by default.
- Allowed deps: `@generic-ai/core`, `@generic-ai/sdk`, all plugins it bundles (`plugin-config-yaml`, `plugin-workspace-fs`, storage, queue, logging, tool, MCP, skill, delegation, messaging, memory, output, and Hono plugins), and `pi`.
- Not responsible for: defining new plugin-owned business models. The preset only wires existing plugins together.

### `@generic-ai/plugin-config-yaml`

- Role: canonical YAML config discovery and validation. Produces the single resolved config layer the rest of the framework consumes.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: kernel bootstrap order, or plugin-owned runtime behavior that is merely configured via YAML.

### `@generic-ai/plugin-workspace-fs`

- Role: local-filesystem workspace services. Backs file tools and memory. Exposes the recommended workspace layout helpers.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: storage, messaging, or any non-filesystem workspace primitive.

### `@generic-ai/plugin-storage-memory`

- Role: in-memory implementation of the storage contract. Intended for tests and fast local iteration.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: durability, concurrency semantics beyond what the contract requires, or any specific plugin's data model.

### `@generic-ai/plugin-storage-sqlite`

- Role: durable SQLite-backed storage implementation. Default local persistence path for the starter preset.
- Allowed deps: `@generic-ai/sdk`, `pi`, SQLite library of choice.
- Not responsible for: non-SQLite backends or messaging and memory data shapes (those belong to their own plugins).

### `@generic-ai/plugin-queue-memory`

- Role: in-process queue implementation. Provides the async execution path that shares the kernel's session machinery.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: external queues, scheduling semantics that other queue plugins might want to express differently.

### `@generic-ai/plugin-logging-otel`

- Role: structured logging plus OTEL tracing plugin. Consumes the kernel event stream.
- Allowed deps: `@generic-ai/sdk`, `pi`, OTEL client libraries.
- Not responsible for: richer observability dashboards, metrics, or analytics surfaces (see `DEF-06`).

### `@generic-ai/plugin-tools-terminal`

- Role: standard `pi` tool for local command execution.
- Allowed deps: `@generic-ai/sdk`, `pi`, `@generic-ai/plugin-workspace-fs` where it needs workspace-aware paths.
- Not responsible for: file operations (those belong to `@generic-ai/plugin-tools-files`) or governance/hardening (deferred).

### `@generic-ai/plugin-tools-files`

- Role: standard `pi` tools for reading, writing, listing, and editing local files.
- Allowed deps: `@generic-ai/sdk`, `pi`, `@generic-ai/plugin-workspace-fs`.
- Not responsible for: terminal commands, storage, or search beyond the filesystem-level primitives file tools natively provide.

### `@generic-ai/plugin-mcp`

- Role: embedded MCP support exposed as a plugin so MCP is never a kernel hard requirement.
- Allowed deps: `@generic-ai/sdk`, `pi`, MCP client libraries.
- Not responsible for: replacing MCP as a protocol. The kernel and SDK must remain MCP-agnostic.

### `@generic-ai/plugin-agent-skills`

- Role: Agent Skills compatibility plugin. Implements the public Agent Skills spec.
- Allowed deps: `@generic-ai/sdk`, `pi`, `@generic-ai/plugin-workspace-fs` for skill discovery on disk.
- Not responsible for: trust gating (deferred) or any product-specific skill catalog.

### `@generic-ai/plugin-delegation`

- Role: simple delegation capability that defines the delegation business model.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: child-session lifecycle or result collection. Those belong to the kernel.

### `@generic-ai/plugin-messaging`

- Role: durable inter-agent messaging, storage-backed in v1.
- Allowed deps: `@generic-ai/sdk`, `pi`. Depends on a storage plugin through the shared storage contract, not on a specific storage implementation, whenever practical.
- Not responsible for: the kernel event stream or in-session message passing.

### `@generic-ai/plugin-memory-files`

- Role: file-backed persistent agent memory with read, write, and search.
- Allowed deps: `@generic-ai/sdk`, `pi`, `@generic-ai/plugin-workspace-fs`.
- Not responsible for: durable non-file memory backends (a future memory plugin can own that).

### `@generic-ai/plugin-output-default`

- Role: default output and finalization plugin. Keeps final response shaping out of the kernel.
- Allowed deps: `@generic-ai/sdk`, `pi`.
- Not responsible for: session lifecycle or canonical run envelope semantics.

### `@generic-ai/plugin-hono`

- Role: official-but-optional Hono integration plugin.
- Allowed deps: `@generic-ai/sdk`, `pi`, `hono`.
- Not responsible for: being part of the kernel or making Hono mandatory at the core layer.

## Examples, Contracts, And Specs

### `examples/starter-hono/`

- Role: runnable reference example for the starter preset (see `TRN-03`).
- Allowed deps: the starter preset and any plugins it needs to demonstrate behavior.
- Not responsible for: being imported by any package in `packages/`.

### `contracts/`

- Role: frozen interface contracts surfaced to plugin authors and external consumers.
- Allowed contents: machine-readable or canonical interface descriptions, typically produced during `KRN-01` and `CFG-01`.
- Not responsible for: implementation, prose documentation, or speculative interfaces.

### `specs/`

- Role: specifications used by docs-as-code and contract-testing workflows.
- Allowed contents: specifications that describe framework behavior precisely enough to verify or generate from.
- Not responsible for: scope and architecture planning (that lives in `docs/planning/`).

## Changing A Boundary

When you need to move code across one of these boundaries:

1. Check the planning pack first.
2. If the boundary change is still correct, add an entry to `docs/decisions/` explaining the trade-off.
3. Update this document and the affected package README in the same change.
