# Project Architecture Blueprint — Generic AI Framework

> Generated: 2026-04-27. Source-of-truth: the planning pack plus the
> actual implementation under `packages/`, `examples/`, `scripts/`,
> `contracts/`, `specs/`, and `.github/workflows/`. Every load-bearing
> claim below is anchored to a file. Where the planning pack and code
> disagree, this document calls out the discrepancy instead of silently
> promoting one source.

---

## 1. Detection Summary

| Aspect | Finding | Evidence |
|---|---|---|
| Language / target | TypeScript 6 strict, ES2024, `module: NodeNext`, ESM only | `tsconfig.base.json:1-44` |
| Runtime | Node 24+ enforced (preinstall hook), npm 11.12.1 pinned | `package.json:8-11`, `scripts/check-node-version.mjs:1-71` |
| Workspace | npm workspaces over `packages/*` and `examples/*` | `package.json:12-15` |
| Lint / format | Biome 2.4.13 (100-col, 2-space, LF, double quotes, trailing commas) | `biome.json:1-84` |
| Tests | Vitest 4 with source aliases for the currently configured test surface, not every `@generic-ai/*` package | `vitest.config.ts:1-48` |
| Build | TS project references; root `tsc -b` plus per-package/example `tsconfig.json` | `tsconfig.json` (23 references), `package.json:20-22` |
| Release | Changesets, per-package independent semver, npm provenance on every public package | `.changeset/config.json:1-15`, `RELEASING.md` |
| Top-level pattern | Layered, plugin-first microkernel built on `pi` (`@mariozechner/pi-coding-agent`) | `packages/core/package.json:18-22`, `docs/decisions/0011-pi-direct-boundary.md` |

The architecture is **layered + ports-and-adapters + event-driven**, with a
bootstrap state machine on top. The kernel exposes typed contracts via the
SDK; capability code lives in plugins; the starter preset wires a default
local-first stack; one entrypoint (`createGenericAI()`) returns an opaque
`GenericAIBootstrap` handle with `run`, `stream`, `stop`.

---

## 2. Repository Layout (as built)

```text
packages/
  core/                              # @generic-ai/core   — kernel
  sdk/                               # @generic-ai/sdk    — public contracts
  preset-starter-hono/               # @generic-ai/preset-starter-hono
  plugin-config-yaml/                # canonical YAML config discovery
  plugin-workspace-fs/               # filesystem workspace + path safety
  plugin-storage-memory/             # in-memory StorageContract
  plugin-storage-sqlite/             # node:sqlite StorageContract (Node 24 native)
  plugin-queue-memory/               # in-process QueueContract
  plugin-logging-otel/               # OTEL-shaped logger over the event stream
  plugin-output-default/             # default OutputPluginContract finalize
  plugin-tools-terminal/             # local bash via pi BashOperations
  plugin-tools-terminal-sandbox/     # Docker-backed sandboxed terminal
  plugin-tools-files/                # safe read/write/list/edit/grep
  plugin-tools-web/                  # fetch/search with DNS allow-list
  plugin-mcp/                        # MCP server registry + transports
  plugin-agent-skills/               # Agent Skills discovery (multi-source)
  plugin-delegation/                 # marker plugin re-exporting SDK delegation types
  plugin-interaction/                # blocking questions + tasks (Hono adapter)
  plugin-messaging/                  # storage-backed inter-agent messaging
  plugin-memory-files/               # JSON-file-backed agent memory + token search
  plugin-hono/                       # Hono SSE transport (/health, /run, /run/stream)

examples/
  starter-hono/                      # runnable server + React/shadcn UI
  terminal-bench/                    # private Terminal-Bench integration workspace
  harness-shootout/                  # JSON-only public harness fixture

contracts/                           # frozen JSON-Schema + canonical contract docs
  config/, run-envelope/, events/, harness/, pi-boundary/, sdk/

specs/                               # behavioral specs (docs-as-code source)
  core/, sdk/, harness-v0.1/

scripts/
  check-node-version.mjs
  check-package-boundaries.mjs       # the architectural gate
  check-biome-helper-ignores.mjs
  generate-docs.mjs                  # writes docs/generated/package-index.md
```

**Important delta from the live tree:** The repo now ships 26 public
packages under `packages/*`, including `plugin-lsp`, `plugin-repo-map`,
`plugin-web-ui`, and `observability`, all with real `package.json` and
workspace metadata. Earlier snapshots reported fewer packages; the
authoritative count is the live workspace list under `packages/`.

The starter preset package declares only `@generic-ai/core`,
`@generic-ai/plugin-config-yaml`, and `@generic-ai/sdk` as dependencies.
Runtime composition is data-driven through the slot/spec list in
`packages/core/src/bootstrap/starter-preset.ts:31-143`, and the `core`
package keeps the mirrored starter descriptor that lists plugin **ids**
without importing plugin packages directly (ADR-0012).

---

## 3. Layering Model And Enforcement

### Layers (downward dependency only)

```text
Examples ──use──> Presets ──compose──> Core
     │              │                  │
     │              ├──wire──> Plugins │
     │              │                  │
     └──may use─────┴───────> SDK <────┘
                              │
Core, SDK, and plugins may use pi directly.
Plugins must not import Core.
SDK must not import Core, plugins, or presets.
```

### Mechanical enforcement: `scripts/check-package-boundaries.mjs`

This script is the architectural gate. Concrete rules
(`scripts/check-package-boundaries.mjs:1-174`):

- Classifies each workspace package by name prefix into `core`, `sdk`,
  `plugin-*`, `preset-*`, or `other`.
- **`@generic-ai/core`** — must not depend on plugins or presets.
- **`@generic-ai/sdk`** — must not depend on core, plugins, or presets.
- **plugins** — must not depend on core or presets.
- The check applies to **both** `package.json` dependencies **and**
  source-file imports/exports (regex-extracted from
  `**/*.{ts,js,mjs,mts,cts}` under `src/`).
- Wired into `npm run lint` (`package.json:25-28`) and therefore into the
  `baseline-quality-gate` workflow.

A second script, `scripts/check-biome-helper-ignores.mjs`, materializes
fixture files inside `.claude`, `.codex`, `.agents` and asserts Biome's
`includes` actually ignores them — a regression test for the lint
configuration itself.

### TypeScript-level enforcement

`tsconfig.base.json:18-33` turns on `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noImplicitReturns`,
`noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax` — strict
typing is the default contract between layers.

---

## 4. Architecture Visualization

### High-level container view (text-C4)

```text
                    +-----------------------------------------------+
                    | Caller (Node app, CLI, server, test)          |
                    +-----+-----------------------------------------+
                          |  createGenericAI(options?)
                          |  createGenericAIFromConfig(options)
                          v
+---------------------------------------------------------------------+
| @generic-ai/core   bootstrap.ts                                     |
|   resolveCapabilities → resolvePorts → composePlugins →             |
|   createPluginHost → ensureStarted (setup → start)                  |
|   executeRun / streamRun → finalizeRunEnvelope → stop()             |
+----+----------------------------------------------------------------+
     | drives lifecycle on
     v
+---------------------------------------------------------------------+
| Plugins composed by mirrored starter descriptor (slots)             |
|  config-yaml → workspace-fs → storage-sqlite → queue-memory →       |
|  logging-otel → tools-terminal → tools-files → mcp → agent-skills → |
|  delegation → messaging → memory-files → output-default → hono      |
+----+----------------------------------------------------------------+
     | compile against
     v
+---------------------------------------------------------------------+
| @generic-ai/sdk   contracts/* + harness/* + events/* + scope/*      |
+----+----------------------------------------------------------------+
     | uses
     v
+---------------------------------------------------------------------+
| pi (@mariozechner/pi-coding-agent v0.70.2)                          |
|  AgentSession, ModelRegistry, AuthStorage, SessionManager, tools    |
+---------------------------------------------------------------------+
```

Open the interactive walkthrough at
[`walkthrough-generic-ai-architecture.html`](walkthrough-generic-ai-architecture.html).
It separates default starter slots from optional/addon packages so
`plugin-tools-web`, `plugin-interaction`, `plugin-repo-map`, `plugin-lsp`,
and the Docker terminal sandbox do not look like core starter defaults.

### Run lifecycle (one execution)

```text
ensureStarted()                                  bootstrap.ts
  ├── runLifecycle("setup")                       plugin-host.ts:157-176 (forward order)
  └── runLifecycle("start")                       plugin-host.ts:157-176 (forward order)

run(task) | stream(task)
  ├── createRunEnvelope(...) status="created"     run-envelope/index.ts:39-67
  ├── canonical events: run.created, run.started  events/taxonomy.ts:7-13
  ├── SessionOrchestrator.createRootSession()     session/orchestrator.ts:50-71
  ├── capability-runtime → pi AgentSession        runtime/capability-runtime.ts
  │     emits tool.* + plugin.* events as plugin-defined
  ├── delegation? → createChildSession + cascade  session/delegation.ts:103-162
  ├── outputPlugin.finalize(run)                  contracts/output.ts:21-26
  └── finalizeRunEnvelope(...) status=succeeded   run-envelope/index.ts:69-102
                                                   |failed|cancelled
stop()
  └── runLifecycle("stop")                        plugin-host.ts:157 (REVERSE order)
```

---

## 5. Kernel Anatomy — `@generic-ai/core/src/`

### 5.1 `bootstrap/`

`bootstrap.ts` (≈1230 lines) is the only file exposing
`createGenericAI` / `createGenericAIFromConfig`. Concrete shape
(`bootstrap.ts:886-1191`, types from `types.ts`):

- `createGenericAI(options?: GenericAIOptions): GenericAIBootstrap`
  - **synchronous** — does not start the lifecycle yet.
  - Resolves capability list, port descriptors, preset, output plugin id
    (default `@generic-ai/plugin-output-default`,
    `bootstrap.ts:57-58`).
  - Composes plugins from the mirrored starter descriptor in
    `starter-preset.ts:31-143` (13 default specs + transport).
  - Returns `{ describe, run, stream, stop, … composition fields }`
    (`types.ts:155-164`).
- `createGenericAIFromConfig(options): Promise<GenericAIConfiguredBootstrap>`
  - **async** — additionally loads canonical config via
    `plugin-config-yaml`, returns `.config`, `.runtimePlan`,
    `.startRuntime()`.
- `ensureStarted()` is gated by an internal state machine
  (`startupState: "idle" | "starting" | "started"`,
  `bootstrap.ts:917-946`) which calls
  `host.runLifecycle("setup")` then `host.runLifecycle("start")`.
- `executeRun` (sync, `bootstrap.ts:948-1056`) and `streamRun`
  (async-iterable of `GenericAIStreamChunk`, `bootstrap.ts:1058-1174`)
  are the two run paths. Stream chunks are tagged unions of `event` or
  `envelope` (`types.ts:145-153`).

### 5.2 `plugin-host/`

`plugin-host.ts:110-188` builds the `PluginHost`:

- Two registries — `plugins` and `manifests` (`types.ts:32-35`).
- `register(plugin)` validates the manifest, normalizes id and
  dependencies, throws `PluginHostError` on duplicate id or invalid
  shape (`errors.ts:1-5` defines the four error codes:
  `invalid-plugin-manifest`, `duplicate-plugin-id`,
  `missing-plugin-dependency`, `cyclic-plugin-dependency`).
- `resolveOrder()` runs a **greedy ordered topological resolver**
  (`dependency-order.ts:99-147`) — not Kahn's algorithm. It picks the
  earliest-registered candidate whose dependencies are all already
  resolved; if none qualifies it runs `findCycle` (DFS,
  `dependency-order.ts:18-69`) and throws.
- `runLifecycle("setup" | "start" | "stop")` —
  `plugin-host.ts:157-176`. Setup and start iterate forward; **stop
  iterates the reversed order**, ensuring teardown is the inverse of
  startup.
- `validate()` returns `readonly PluginHostIssue[]`, a non-throwing way
  to inspect manifest problems before lifecycle runs.

`PluginManifest` in core is intentionally permissive
(`types.ts:3-9`) — `id: string`, optional `dependencies: readonly
string[]`, plus an open index signature. The richer
`PluginManifest` in `@generic-ai/sdk/contracts/plugin.ts:16-24`
(with `kind: "plugin"`, `name`, `version`, `tags`) is what
plugin authors target; the core host accepts any extra fields and
ignores them.

### 5.3 `registries/`

Single file `registry.ts`. `Registry<T>` is a thin wrapper around
`Map<string, T>` (`registry.ts:21-34, 50`):

- `register(key, value): T` — throws on duplicate.
- `has`, `get`, `require` (throws if missing), `delete`, `clear`.
- `entries()` returning `RegistryEntry<T>`, plus `keys()`, `values()`,
  `name`, `size`.
- `createRegistry<T>(name)` — the only export factory.

Used internally for plugin/manifest registries inside the host.

### 5.4 `scope/`

A single `scope/index.ts`. The `Scope` interface
(`scope/index.ts:19-23`) carries `id`, `rootId`, `lineage`,
optional `parentId`, `kind`, `label`, `metadata`. Functions:

- `createRootScope(input?)` (`:107-118`) — uses `randomUUID()` if no id,
  freezes the result, sets `rootId = id`, `lineage = [id]`.
- `createChildScope(parent, input?)` (`:120-135`) — appends to
  `lineage`.
- Helpers: `isScope`, `isRootScope`, `scopeDepth`, `scopeLineage`,
  `withScope`.

Scope is the common execution-context boundary that travels with
plugin runtime contexts, sessions, and events.

### 5.5 `session/`

`SessionOrchestrator` (`orchestrator.ts:38+`) tracks the session tree.
Status enum (`types.ts:5`): `"active" | "succeeded" | "failed" |
"cancelled"`. Kind enum: `"root" | "child"`.

Methods: `createRootSession`, `createChildSession`, `completeSession`,
`failSession`, `cancelSession`, `getSession`, `collectTerminalStates`.
Failures and cancellations cascade: a failed parent failures its still
`active` children (orchestrator code path verified by `explore`
agent — see `session/orchestrator.ts:124-159`).

`delegation.ts:103-162` provides `delegate` and `delegateMany`.
`delegateMany` runs requests through `Promise.all`, each one a child
session, each terminalized into a `DelegationResult`
(SDK `contracts/delegation.ts`).

### 5.6 `events/`

`taxonomy.ts:3` declares the canonical families:

```ts
export const canonicalEventFamilies = ["run", "session", "delegation", "plugin"] as const;
```

Lifecycle names:

- `taxonomy.ts:7-13` — `run.created|started|completed|failed|cancelled`
  (5).
- `taxonomy.ts:17-28` — 10 session names including
  `session.child.{created,started,completed,failed,cancelled}`.
- `taxonomy.ts:32-39` — 6 delegation names.
- Plugin events use the format
  `plugin.${pluginId}.${localName}` (`taxonomy.ts:51`).

`CanonicalEvent` (`taxonomy.ts:74-84`) carries `eventId`, monotonically
increasing `sequence`, `occurredAt`, `name`, `origin {namespace,
pluginId?, subsystem?}`, free-form `data`, plus correlation ids
(`scopeId`, `runId`, `rootSessionId`, `sessionId`, `parentSessionId?`,
`delegationId?`).

`stream.ts:42-55` defines the in-memory `CanonicalEventStream`:
ordered append-only `emit`, history-bounded `snapshot`, and
`subscribe(listener, filter?)` where `filter` (`stream.ts:12-19`)
narrows by `names`, `families`, `namespaces`, `pluginId`,
`fromSequence`, or arbitrary predicate.

> **Correction to a planning-doc claim found earlier.** Some prose
> mentions `tool | terminal | policy | artifact | handoff` families.
> The kernel only knows the four families above; tool/handoff/policy
> events are emitted under `plugin.*` namespacing today (verified
> `taxonomy.ts:3`).

### 5.7 `run-envelope/`

`run-envelope/index.ts` (102 lines) defines `RunEnvelope` shape
(`kind: "run-envelope"`, `runId`, `rootScopeId`, `rootAgentId?`, `mode:
"sync"|"async"`, `status: "created"|"running"|"succeeded"|"failed"|
"cancelled"`, `timestamps`, `eventStream?`, `outputPluginId?`,
`output?`).

`createRunEnvelope` (`:39-67`) returns a frozen envelope with status
`"created"`. `finalizeRunEnvelope` (`:69-102`) calls
`outputPlugin.finalize({...})` and returns a frozen envelope with the
`OutputEnvelope` payload attached and the timestamp/status updated.

### 5.8 `run-modes/` and `scheduler/`

`session-machine.ts` defines the in-flight session model used by the
shared sync/async run code (`session-machine.ts:3, 17-31, 153-167`):
state `"idle" | "running" | "succeeded" | "failed" | "cancelled"`,
methods `start`, `succeed`, `fail`, `cancel`, `createChild`, `observe`,
`emit`. `SyncRunMode` and `AsyncRunMode` (`run-modes.ts:12-21`) wrap
this and accept a `RunScheduler`.

`scheduler/`: three implementations of the same `RunScheduler`
interface (`scheduler/types.ts:1-8`):

- `ImmediateScheduler` — `void task()` synchronously
  (`immediate-scheduler.ts:11-22`).
- `MicrotaskScheduler` — `queueMicrotask(task)`
  (`microtask-scheduler.ts:11-25`).
- `ManualScheduler` — queue + `flushNext()` / `flushAll()` for
  deterministic tests (`manual-scheduler.ts:22-54`).

### 5.9 `runtime/`

`runtime/types.ts:27-40` defines `GenericAILlmRuntime`:

```ts
readonly adapter: GenericAILlmRuntimeAdapter;   // "openai-codex" | "pi"
readonly model: string;
readonly run(input, options?): Promise<GenericAILlmRunResult>;
readonly stream(input, options?): AsyncIterable<GenericAILlmStreamChunk>;
readonly close?(): Promise<void>;
```

`runtime/openai-codex.ts:18` defines
`OPENAI_CODEX_PI_PROVIDER = "openai-codex"` and routes through pi's
`AuthStorage`, `ModelRegistry`, and `createAgentSession` — there is
**no separate OpenAI client dependency** in `core/package.json:18-22`,
which only declares `@sinclair/typebox`, `@generic-ai/sdk`, and
`@mariozechner/pi-coding-agent`.

`runtime/pi.ts` (≈28 lines) re-exports `createAgentSession` and
`createAgentSessionRuntime` from pi.

`runtime/capability-runtime.ts` exposes capability binding interfaces
(`PiCapabilityFileTools`, `PiCapabilityMcp`, `PiCapabilityMemory`,
etc.) and `runCapabilityPiAgentSession` which is what wires plugin
tools into a pi agent session.

### 5.10 `harness/`

`agent-harness.ts` builds the public `AgentHarness` control plane
on top of pi (`packages/core/src/harness/agent-harness.ts:1-80`).
It imports `AgentHarnessRole`, `AgentHarnessCapabilityEffect`,
`getAgentHarnessToolEffects`, `withAgentHarnessToolEffects` from the
SDK and uses pi `AuthStorage` / `ModelRegistry` / `SessionManager`
(`agent-harness.ts:33-39`). It enforces role allow-sets on tools
before binding (role policy is one of `"coordinator" | "read-only" |
"build" | "verify"`, `agent-harness.ts:59`).

`benchmark-runner.ts:332-381` — `runHarnessBenchmark()` validates the
mission ref, compiles all candidate harnesses through
`compileHarnessDsl`, generates a deterministic run-id fingerprint, and
runs trials × candidates. `runTrial` builds the prompt, resolves the
runtime, emits trace events (21 event types declared in
`sdk/harness/types.ts:364-384`), and scores via `scoreMission`.
Standard metrics scored in `benchmark-runner.ts:147-206`:
`task_success`, `artifact_completeness`, `trace_completeness`,
`wall_time`, `cost_usd`, `handoff_count`, `policy_violations`.

---

## 6. SDK Anatomy — `@generic-ai/sdk/src/`

The SDK is the **single contract surface** plugins compile against.
Everything is types and small identity helpers; there is no runtime
behavior beyond utility factories.

### 6.1 `contracts/`

| File | Key exports |
|---|---|
| `plugin.ts:1-44` | `PluginManifest` (with `kind:"plugin"`), `PluginContract<TConfig>`, `PluginRuntimeContext<TConfig>` (carries `pluginId`, `manifest`, `scope`, `config`, `registries`, optional `storage`/`workspace`/`queue`/`runtime`) |
| `lifecycle.ts` | `LifecycleHooks` (`configure`, `start`, `stop`); `LifecyclePhase` enum with 9 states |
| `registry.ts` | `RegistryContract<TValue, TKey>` |
| `config-schema.ts` | `ConfigSchemaContract<TConfig>` with `parse` + optional `merge` |
| `storage.ts:1-30` | `StorageContract` (kind `"storage"`, `get`, `set`, `delete`, `list(filter?)`, `clear`); records keyed by `{namespace, collection, id}` |
| `queue.ts:3-35` | `QueueContract` with state `"queued"|"leased"|"succeeded"|"failed"|"cancelled"`; `enqueue`, `lease`, `ack`, `nack`, `cancel`, `size` |
| `workspace.ts:1-34` | `WorkspaceContract` and `WorkspaceLayout {root, framework, agents, plugins, skills, shared}` |
| `output.ts:1-26` | `OutputPluginContract` with `finalize(input): OutputEnvelope` |
| `sandbox.ts:9-228` | `SandboxRuntime` (`bash|node|python`), `SandboxNetworkMode` (`isolated|allowlist|open`), `SandboxFileIOMode`, `SandboxPolicy`, `SandboxSession`, `SandboxExecutionResult` plus `parseSandbox*` / `mergeSandbox*` helpers |
| `delegation.ts` | `DelegationRequest`, `DelegationResult`, `DelegationExecutor`; status enum `"succeeded"|"failed"|"cancelled"` |
| `shared.ts` | `Awaitable<T>`, `JsonValue`, `JsonObject` |

### 6.2 `harness/`

Owns **Harness DSL + Generic Agent IR**. `harness/types.ts:185-206`
defines `HarnessDsl` with `kind: "generic-ai.harness"`,
`schemaVersion: "0.1"`, plus `packages`, `capabilities`, `agents`,
`spaces`, `relationships`, `protocols`, `policies`, `artifacts`.
`AgentSpec` (`:46-57`), `CapabilitySpec` (`:28-44`),
`PolicySpec` (`:116-127`) with effect enum
`"allow"|"deny"|"require_approval"|"redact"|"rewrite"`.

`CompiledHarness` (`:229-247`) carries `CompiledActor[]`, a sha256
`fingerprint`, and a `packageVersions` map. `MissionSpec` (`:254-283`)
and `BenchmarkSpec` (`:291-315`) define the evaluation harness inputs.
`TraceEvent` (`:364-384`) lists 21 trace event types.

`harness/protocols.ts` ships four standard protocols
(`createPipelineProtocol` `:69-104`, `createVerifierLoopProtocol`
`:106-140`, `createHierarchyProtocol` `:142-178`,
`createSquadProtocol` `:180-221`) and a `STANDARD_PROTOCOLS` array.

`harness/compiler.ts` provides `stableJson`,
`createStableFingerprint` (sha256), and `compileHarness*` helpers used
by `runHarnessBenchmark` in core.

### 6.3 `events/`, `scope/`, `run-envelope/`, `config/`, `pi/`

- `events/` defines `CanonicalEvent`, `CanonicalEventName`,
  `CanonicalEventFamily`, the four lifecycle name unions, and factory
  helpers (`createRunLifecycleEvent`, `createSessionLifecycleEvent`,
  `createDelegationLifecycleEvent`, `createPluginEvent`). The kernel's
  `events/taxonomy.ts` mirrors the same types — they are kept in sync
  intentionally.
- `scope/index.ts` (179 lines) duplicates the `Scope` factories so
  plugin code can build scopes without importing core. Core imports its
  own copy; plugins import from `@generic-ai/sdk`.
- `run-envelope/index.ts` (62 lines) defines
  `RunEnvelope<TOutput>`, `RunEnvelopeMode`, `RunEnvelopeStatus`,
  `RunEnvelopeFinalizationInput`, `RunEnvelopeFinalizer`.
- `config/types.ts` defines `ResolvedConfig`, `FrameworkConfig`,
  `AgentConfig`, `PluginConfig`, `PresetConfig`, plus the
  `AGENT_ID_PATTERN` and `PACKAGE_NAME_PATTERN` regexes.
- `pi/runtime.ts` re-exports `AgentSession`, `AgentSessionRuntime`,
  `SessionManager`, `SettingsManager`, `ModelRegistry`,
  `createAgentSession`, `createAgentSessionRuntime`. `pi/tools.ts`
  re-exports the bash/file/grep/find/ls tool factories from
  `@mariozechner/pi-coding-agent` plus pre-instantiated singletons
  (`bashTool`, `readTool`, …, `codingTools`, `readOnlyTools`).

### 6.4 `helpers/` and `index.ts`

`helpers/` exposes identity-typed builders: `definePlugin`,
`defineLifecycle`, `defineConfigSchema`, `defineStorage`,
`defineQueue`, `defineWorkspace`, `defineOutputPlugin`, plus
`createRegistry` and the scope factories. They exist purely for
type inference at call sites.

`packages/sdk/src/index.ts:1-26` re-exports modules both as namespaces
(`config`, `contracts`, `helpers`, `harness`, `pi`, `scope`) **and**
as star exports — so `import { StorageContract } from "@generic-ai/sdk"`
and `import { contracts } from "@generic-ai/sdk"` both work.

---

## 7. Plugins — Concrete Behavior (one paragraph each)

Every plugin sits in `packages/plugin-*/src/`, declares a
`PluginContract` with manifest id `@generic-ai/<dir>`. Notable
findings from the actual sources:

**plugin-config-yaml** — depends on `yaml@^2.8.3` and `zod@^4.3.6`
(no other plugins). `resolution.ts:66-80` discovers canonical YAML
under `.generic-ai/`, parses, and produces a single `ResolvedConfig`.
`assertCanonicalConfig` (`index.ts:84-98`) joins parse failures and
schema-validation diagnostics into one thrown error.

**plugin-workspace-fs** — no npm deps. `isInsideRoot`
(`index.ts:40-51`), `ensureInsideRoot`, `assertWorkspaceToken`
(`index.ts:53-71`), and `resolveSafeWorkspacePath` (`:84-109`) are the
path-safety primitives. The last one calls `fs.realpath` to reject
symlinks that escape the workspace root. Layout (`:130-143`):
`.generic-ai/agents`, `.generic-ai/plugins`, `.agents/skills`,
`workspace/agents`, `workspace/shared`.

**plugin-storage-memory** — no npm deps. Uses `structuredClone` on
read/write (`index.ts:320-347`); records carry version counters and
`createdAt`/`updatedAt`. `transaction()` (`:174-190`) drafts the
namespaces and fails fast on async operations
(`"INVALID_TRANSACTION"`).

**plugin-storage-sqlite** — uses Node 24's native `node:sqlite`
(`DatabaseSync`) and serialises values with `node:v8`'s
`serialize`/`deserialize` into BLOB columns (`index.ts:3-4, 534-548`).
Schema init: `records(namespace, key, value BLOB, version, created_at,
updated_at)` with composite PK and namespace index, behind a PRAGMA
schema-version migration (`:356-390`). Non-`:memory:` databases get
WAL plus `foreign_keys=ON`, `trusted_schema=OFF` (`:514-520`).

**plugin-queue-memory** — pure Node `EventEmitter`. Sort key is
`runAt → priority desc → insertion sequence` (`index.ts:431-444`).
`#arm()` schedules the next pump via `setTimeout`/`setImmediate`
based on the next job's `runAt` (`:506-542`). AbortSignal integration
removes the job from pending and rejects with a fresh AbortError
(`:313-332`).

**plugin-logging-otel** — implements an OTEL-shaped logger over the
canonical event stream **without depending on `@opentelemetry/*`**.
Subscriptions accept either callback or async iterable
(`index.ts:212-319`). Spans are tracked in `#openSpans` and finalized
on completed/failed/cancelled (`:338-362`). `sanitizeValue` uses a
`WeakSet` to break cycles and special-cases Error/Date/URL/BigInt
(`:665-685`).

**plugin-output-default** — finalizes runs to a
`DefaultOutputRecord` (`index.ts:14-23`). It tries `JSON.stringify`,
falls back to `node:util.inspect`, extracts text-like fields
(`summary|text|message`) when present, and truncates summaries to
120 chars with whitespace compression (`:184-192`).

**plugin-tools-terminal** — depends on
`@generic-ai/plugin-workspace-fs` and `@generic-ai/sdk`. CWD is
resolved through `resolveSafeWorkspacePath` (`index.ts:91-99`).
Timeouts are converted ms → seconds because pi's BashOperations
takes seconds while the plugin API takes ms (`:124-131`). Env merging
goes `process.env` → `options.env` → `request.env` (`:53-80`).

**plugin-tools-terminal-sandbox** — Docker-backed. Backend constant
`"docker"`, supported runtimes `bash|node|python`, default images
`node:24-bookworm-slim` and `python:3.12-slim`. Default policy:
30s timeout, 512 MB memory, isolated network, readonly file mount.
Workspace mounts to `/workspace`, output to `/workspace-output`, and
`GENERIC_AI_SANDBOX_OUTPUT_DIR` is exported into the container.
Allowlist mode brings up a proxy sidecar on port 3128 in a private
network `generic-ai-sandbox-*` (verified
`packages/plugin-tools-terminal-sandbox/src/index.ts:1-100`).

**plugin-tools-files** — `walkFiles` (`index.ts:115-150`) uses
`lstat` and never follows symlinks (`if (info.isSymbolicLink())
return []`). Writable paths are revalidated via
`resolveSafeWorkspacePath` after the parent dir is created
(`:174-181`). A small custom glob matcher escapes regex specials and
maps `*` → `.*`, `?` → `.` (`:86-113`).

**plugin-tools-web** — imports `lookup` from `node:dns/promises` and
`isIP` from `node:net` (`index.ts:1-2`). Defaults: 10 s fetch timeout,
12 000 char text cap, 5 search results, 5 redirects, 50 KB / 250 KB
content limits (`:10-23`). Allow/block policy is enforced after DNS
resolution.

**plugin-mcp** — server registry keyed by id (`index.ts:27-36`).
`resolveLaunch` merges per-server config with env overrides; stdio
servers require `command`, http/sse require `url`. Duplicate
registration throws `McpRegistryError("DUPLICATE_SERVER")`
(`:89-92`). `describeForPrompt` formats a readable list for agents
(`:129-144`).

**plugin-agent-skills** — depends on `plugin-workspace-fs` and pi
`@mariozechner/pi-coding-agent`. Discovery walks four sources in
order (`index.ts:87-137`): project `.agents/skills`, custom dirs,
`~/.generic-ai/skills`, and `$CODEX_HOME/skills`. Case-insensitive
deduplication preserves first occurrence (`:70-85`). The plugin
aggregates diagnostics across sources before formatting via
`formatSkillsForPrompt` (`:144-167`).

**plugin-delegation** — marker-only. The whole `index.ts` re-exports
SDK delegation types and exports `name` and `kind`. Lifecycle and
child-session machinery live in the kernel.

**plugin-interaction** — depends on `hono@^4.12.15`. Question kinds:
`text | single_choice | multi_choice` with optional timeout
(`index.ts:16-50`). Tasks follow `pending → in_progress → completed`
(`:67-71`).

**plugin-messaging** — default thread id is `[from, to].sort().join("::")`
(`index.ts:85-87`). Search tokenizes on non-alphanumerics, scores by
match count (`:95-115`). O(1) lookup by `messageId`; inbox/thread
listings full-scan their namespaces (`:125-129`).

**plugin-memory-files** — depends on `plugin-workspace-fs`. One JSON
file per memory entry under `workspace/agents/{agentId}/memory/`,
keyed by `encodeURIComponent(id)` (`index.ts:86-95`). `createdAt`
is preserved on update; `updatedAt` is always refreshed (`:137-156`).
Search uses the same token scoring as messaging, defaults to limit 5
(`:164-172`).

**plugin-hono** — depends on `hono@^4.12.15`. Three routes
(`index.ts:228-318`): `GET /health`, `POST /run` (sync), `POST
/run/stream` (SSE). SSE serialization writes `id:`, `event:`, `data:`
lines, handles undefined payload as empty frame (`:118-144,
146-210`); the `ReadableStream` cleans up via abort listener and
`iterator.return()` on cancel.

**preset-starter-hono** — declares only `@generic-ai/core`,
`@generic-ai/plugin-config-yaml`, `@generic-ai/sdk` in deps. Slots
(`index.ts:51-65`): `config | workspace | storage | queue | logging
| terminalTools | fileTools | mcp | skills | delegation | messaging |
memory | output | transport`. Sandbox-mode resolution
(`:27-49`) is environment-aware (development vs production), supports
`default | environment | explicit` sourcing and `warn | fail`
fallback, and probes Docker availability before swapping
`plugin-tools-terminal` for `plugin-tools-terminal-sandbox`. Plugin
composition (`:89-100`) supports slot overrides and addon plugins
inserted before/after slots.

---

## 8. Data Architecture

- **Storage records** are namespaced (`StorageContract` shape:
  `{namespace, collection, id}` keys, opaque `value`, `updatedAt`,
  optional `metadata`). Two implementations satisfy the same contract;
  tests exercise both.
- **Workspace layout** is pinned in code (`WorkspaceContract.layout`
  fields plus the constants in `plugin-workspace-fs/index.ts:130-143`).
- **Run envelope** is small and stable (see §5.7). Plugin-defined
  payload lives under `output`.
- **Messaging records** and **memory records** define their own JSON
  shapes inside their plugins; the kernel does not own those schemas.
- **Sandbox results** are typed in
  `sdk/contracts/sandbox.ts:9-228` (`SandboxExecutionResult`:
  `command`, `exitCode`, `stdout`, `stderr`, `durationMs`,
  `timedOut`, `truncated`).

Validation is staged: schema-fragment validation at config load
(`plugin-config-yaml`), structural checks via SDK contract types and
Typebox schemas in core/runtime, business validation inside each
plugin.

---

## 9. Cross-Cutting Concerns

### Authentication & authorization

- No identity layer ships today. ADR-0019 (in
  `docs/decisions/`) records identity/auth as a future plugin slot.
- `plugin-hono` enforces an in-process bearer token when not bound to
  loopback (env `GENERIC_AI_AUTH_TOKEN`,
  `examples/starter-hono/README.md`).
- Harness role policy filters tools by capability effect *before*
  binding into pi (`packages/core/src/harness/agent-harness.ts:59`,
  using `getAgentHarnessToolEffects` /
  `withAgentHarnessToolEffects` from the SDK).

### Sandboxing

- `SandboxContract` (SDK) defines runtime, network mode, file IO mode,
  policy, session, result. The Docker plugin enforces it
  (`packages/plugin-tools-terminal-sandbox/src/index.ts:1-100`).
- Network modes: `isolated | allowlist | open`. Allowlist mode
  attaches an HTTP proxy sidecar in a dedicated network and mounts a
  proxy config file.

### Errors

- `PluginHostError` (`plugin-host/errors.ts:1-5`) carries a typed
  `code` and field-specific data.
- `SessionErrorSnapshot` (`session/types.ts:11-15`) is a
  serialization-friendly `{name, message, stack}` so callers don't
  parse stacks.
- `executeRun` finalizes the envelope on throw with status
  `"failed"`; the canonical event stream emits `run.failed`.

### Logging / observability

- `plugin-logging-otel` subscribes to the `CanonicalEventStream` and
  produces span-shaped output. Dashboards/metrics are explicitly out of
  scope (ADR-0020).

### Configuration

- `.generic-ai/{framework.yaml, agents/<id>.yaml, plugins/<id>.yaml}`.
  `plugin-config-yaml/discovery.ts:47-128` discovers only the framework,
  agent, and plugin concerns; harness declarations live in specs/examples
  and are compiled by the SDK/core harness path, not by config discovery.
  Patterns enforced via
  `AGENT_ID_PATTERN` (`sdk/config/types.ts:3`) and
  `PACKAGE_NAME_PATTERN` (`:4`).

---

## 10. Service Communication

- **In-process default.** `plugin-queue-memory` shares the kernel's
  session machinery; sync and async run modes use the same session
  state machine (`run-modes/`).
- **HTTP/SSE.** `plugin-hono` is the only HTTP transport in the tree.
  The example mounts it at the path prefix declared in the config
  (default `/starter`).
- **Inter-agent messaging.** Durable, namespaced storage
  (`plugin-messaging`); not the canonical event stream.
- **MCP.** `plugin-mcp` adds Model Context Protocol servers as a
  registry. The kernel/SDK never reach for MCP types directly.

---

## 11. Testing Architecture

- **Tooling.** Vitest 4 at the root (`vitest.config.ts:1-48`).
  Workspace aliases map every `@generic-ai/*` to its `src/index.ts`,
  so tests import the source directly without rebuilding.
- **Test discovery patterns:** `packages/*/src/**/*.{test,spec}.ts`,
  `packages/*/test/**`, `examples/**`, `scripts/**`.
- **Determinism hooks.**
  - `SessionOrchestrator` accepts injected `now()` and `idFactory()`
    (`session/orchestrator.ts:33-47`).
  - `ManualScheduler` lets tests step through async work explicitly.
  - In-memory storage and queue plugins are the default test doubles.
- **Live-provider smoke** — `examples/starter-hono/src/live-smoke.test.ts`
  is gated by `GENERIC_AI_ENABLE_LIVE_SMOKE=1`, run only via the
  manually-triggered `live-provider-smoke.yml` workflow.

---

## 12. Build, CI, Release

### Local quality gate (`package.json:16-37`)

```bash
npm run typecheck   # tsc -b --pretty + rimraf cleanup of dist/tsbuildinfo
npm run lint        # check:boundaries → check:biome-helper-ignores → biome lint
npm run test        # vitest run
npm run build       # tsc -b
npm run docs:check  # generate-docs.mjs --check
```

### CI workflows (`.github/workflows/`)

| Workflow | Trigger | Jobs |
|---|---|---|
| `baseline-quality-gate.yml` | PR/push to main, merge_group | parallel `baseline-typecheck`, `baseline-lint`, `baseline-test`, `baseline-build` (Node 24, npm 11.12.1) |
| `quality-gate.yml` | PR/push/main, dispatch | sequential typecheck → lint → test → build |
| `docs.yml` | PR/push/main, dispatch | `npm run docs:check` |
| `security.yml` | PR/push/main, weekly cron Mon 13:22 UTC | `npm audit --audit-level=high --omit=optional` (continue-on-error) |
| `live-provider-smoke.yml` | manual | runs `live-smoke.test.ts` against pi openai-codex |

### Releases

`.changeset/config.json` pins
`baseBranch: main`, `access: public`, `updateInternalDependencies:
patch`, ignores both private example workspaces, and disables
versioning/tagging of private packages. Per-package independent
semver (ADR-0003); npm provenance attestations on each public
package's `publishConfig`.

---

## 13. Extending The System

**Add a new capability:**

1. Add a contract type to `packages/sdk/src/contracts/<name>.ts` and
   export from `contracts/index.ts`. If it freezes a wire format,
   mirror it under `contracts/<name>/`.
2. Create `packages/plugin-<name>/` with manifest, optional
   `configSchema`, and lifecycle hooks. Depend only on
   `@generic-ai/sdk`, `pi`, and any narrow plugin dep documented in
   `docs/package-boundaries.md`.
3. Add the package to `tsconfig.json` references and to
   `vitest.config.ts` aliases.
4. Wire it into a preset (or expose a slot/addon override). Do not
   import the plugin from `@generic-ai/core`.
5. Declare capability effects on every tool so harness role policy
   can filter it (`getAgentHarnessToolEffects` in
   `sdk/harness/types.ts`).
6. Add a changeset under `.changeset/` at the appropriate severity.
7. Run the local gate plus `docs:check`.

**Common pitfalls observed in code:**

- ❌ Importing `@generic-ai/core` from a plugin or the SDK — caught by
  `scripts/check-package-boundaries.mjs`.
- ❌ Reading config outside `plugin-config-yaml`'s `ResolvedConfig`.
- ❌ Adding `@opentelemetry/*` packages to `plugin-logging-otel` — the
  OTEL plugin is intentionally a hand-rolled OTEL-shaped logger, not
  an OTEL SDK consumer.
- ❌ Following symlinks in file/workspace plugins — `walkFiles` and
  `resolveSafeWorkspacePath` both refuse to.
- ❌ Skipping changesets on a publishable package change — the
  release pipeline expects them.

---

## 14. Architectural Decision Records

Located under `docs/decisions/` (24 files including the README index):

```
0001 monorepo-scaffold
0002 base-toolchain
0003 release-and-publishing
0004 config-contracts-and-discovery     (dual: 0004 sdk-contracts)
0005 plugin-host                        (dual: 0005 starter-preset-contract)
0006 scope-primitive
0007 session-orchestration
0008 canonical-event-stream
0009 shared-run-modes
0010 run-envelope
0011 pi-direct-boundary
0012 bootstrap-api
0013 sandboxed-execution
0014 runtime-governance-and-security-controls
0015 ci-and-branch-control
0016 security-and-supply-chain-baseline
0017 agent-boundaries-ownership-task-discovery
0018 docs-as-code-baseline
0019 identity-auth-plugin-boundary
0020 advanced-observability
0021 agents-as-code-harness-spine
```

(33 ADR files plus `README.md` under `docs/decisions/`; 31 unique
numbered ADRs with two pairs of dual-numbered entries: 0004 and 0005.)

---

## 15. Governance Surface (verified)

| Mechanism | Location |
|---|---|
| Boundary check (deps + imports) | `scripts/check-package-boundaries.mjs` |
| Helper-path lint hygiene | `scripts/check-biome-helper-ignores.mjs` |
| Doc index regeneration | `scripts/generate-docs.mjs` (`docs:check` in CI) |
| Node version pinning | `scripts/check-node-version.mjs` (preinstall hook) |
| Required CI gate | `baseline-quality-gate.yml` |
| Branch protection guidance | `docs/branch-protection.md` |
| Ownership map | `docs/ownership.md` |

---

## 16. Blueprint Maintenance

Update this document whenever any of the following change:

- A new package appears under `packages/` or `examples/`.
- A contract under `packages/sdk/src/contracts/` is added, removed, or
  renamed.
- The starter mirrored descriptor in
  `packages/core/src/bootstrap/starter-preset.ts` changes shape or
  membership.
- An ADR lands under `docs/decisions/`.
- `scripts/check-package-boundaries.mjs` rules change.
- `tsconfig.json` references or `vitest.config.ts` aliases change.

The blueprint is intentionally code-anchored; if the code shape and
this doc disagree, the doc is wrong.
