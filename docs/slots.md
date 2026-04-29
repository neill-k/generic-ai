# Research Slots

This registry maps shipped Generic AI plugins and the starter preset to the
research slots or implementation categories they declare in `package.json`.

Slots describe the architectural role a package plays in a harness. Categories
describe support packages that are needed to run a harness but are not research
methods by themselves. The metadata is additive: package names, imports, and
runtime behavior do not change.

Decision record: `docs/decisions/0033-research-slots.md`.

## Metadata Contract

Slot-classified plugins declare:

```json
{
  "genericAi": {
    "kind": "plugin",
    "slot": "tool-policy",
    "method": "docker-sandbox-terminal.v1"
  }
}
```

Infra, transport, and preset packages declare:

```json
{
  "genericAi": {
    "kind": "plugin",
    "category": "transport",
    "method": "hono.v1"
  }
}
```

`method` is a method-family token. It is not a frozen protocol ABI by itself;
the package's exported TypeScript contracts and decision records remain the
authoritative runtime contracts.

## Slot Packages

| Slot | Package | Method family | Canonical harness usage |
| --- | --- | --- | --- |
| `planning` | `@generic-ai/plugin-repo-map` | `repo-map-orientation.v1` | Starter preset `repoMap` slot for repository orientation tools; attach to planner or explorer roles that need read-only repo context. |
| `coordination` | `@generic-ai/plugin-delegation` | `delegation.v1` | Starter preset `delegation` slot for package-owned delegation semantics over kernel child sessions. |
| `memory` | `@generic-ai/plugin-memory-files` | `file-backed-memory.v1` | Starter preset `memory` slot for local persistent memory; the fault-injection fixture models stale-memory boundary behavior against this slot family. |
| `communication` | `@generic-ai/plugin-interaction` | `user-interaction.v1` | Use when a harness role may ask blocking user questions or expose task-tracking state. |
| `communication` | `@generic-ai/plugin-messaging` | `storage-backed-messaging.v1` | Starter preset `messaging` slot for durable inter-agent messages across a run. |
| `tool-policy` | `@generic-ai/plugin-lsp` | `lsp-read.v1` | Starter preset `lsp` slot for diagnostics, document symbols, definitions, and references. |
| `tool-policy` | `@generic-ai/plugin-tools-files` | `local-file-tools.v1` | `examples/harness-shootout/candidates/*` as `capability.files`; starter preset `fileTools` slot. |
| `tool-policy` | `@generic-ai/plugin-tools-terminal` | `local-terminal.v1` | Starter preset `terminalTools` slot when Docker sandboxing is disabled or unavailable. |
| `tool-policy` | `@generic-ai/plugin-tools-terminal-sandbox` | `docker-sandbox-terminal.v1` | `examples/harness-shootout/candidates/*` as `capability.terminal`; starter preset sandbox selection when `GENERIC_AI_SANDBOX=docker` or production defaults request it. |
| `tool-policy` | `@generic-ai/plugin-tools-web` | `web-fetch-search.v1` | Use for web fetch/search missions that need shared host allow/block policy enforcement. |
| `reporting` | `@generic-ai/plugin-logging-otel` | `otel-tracing.v1` | Starter preset `logging` slot for structured logs and trace emission. |
| `reporting` | `@generic-ai/plugin-output-default` | `default-final-output.v1` | Starter preset `output` slot for final response and output shaping outside the kernel. |

## Empty Slots

These slots are part of the accepted vocabulary, but no shipped plugin declares
them yet:

| Slot | Intended package family |
| --- | --- |
| `recovery` | Retry, rollback, repair, and supersession methods that make recovery behavior directly comparable across harnesses. |
| `evaluation` | Graders, validators, benchmark scorers, and report-quality checks that score harness output without becoming runtime coordination logic. |

## Infra And Transport Categories

| Category | Package | Method family | Canonical harness usage |
| --- | --- | --- | --- |
| `infra` | `@generic-ai/plugin-config-yaml` | `yaml-config.v1` | Starter preset `config` slot for canonical config discovery and validation. |
| `infra` | `@generic-ai/plugin-queue-memory` | `in-process-queue.v1` | Starter preset `queue` slot for local async execution. |
| `infra` | `@generic-ai/plugin-storage-memory` | `in-memory-storage.v1` | Fast local/test storage implementation for harnesses that do not need durable state. |
| `infra` | `@generic-ai/plugin-storage-sqlite` | `sqlite-storage.v1` | Starter preset `storage` slot for durable local persistence. |
| `infra` | `@generic-ai/plugin-workspace-fs` | `workspace-filesystem.v1` | Starter preset `workspace` slot; backs file, terminal, memory, and skill discovery packages. |
| `transport` | `@generic-ai/plugin-agent-skills` | `agent-skills.v1` | Starter preset `skills` slot for Agent Skills compatibility and progressive disclosure. |
| `transport` | `@generic-ai/plugin-hono` | `hono.v1` | Starter preset `transport` slot for the optional Hono server integration. |
| `transport` | `@generic-ai/plugin-mcp` | `mcp-embedded.v1` | Starter preset `mcp` slot for embedded MCP support without making MCP a kernel requirement. |
| `transport` | `@generic-ai/plugin-web-ui` | `local-web-console.v1` | Local-first web console plugin used by the starter example and console surfaces. |

## Preset

| Category | Package | Method family | Canonical usage |
| --- | --- | --- | --- |
| `preset` | `@generic-ai/preset-starter-hono` | `local-first-hono-starter.v1` | `examples/starter-hono/` and `createStarterHonoPreset()`; composes the default local-first Hono starter stack. |

## Outside The Slot Registry

`@generic-ai/core`, `@generic-ai/sdk`, and `@generic-ai/observability` are public
packages, but they are architectural layers rather than plugin slots. Core owns
kernel execution, the SDK owns the public harness contracts, and observability
owns the read-only surface around run metadata, traces, metrics, and reports.
