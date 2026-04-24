# Architecture Decision Records

This directory holds the Generic AI framework's architecture decision records (ADRs).

## Convention

- Files are numbered and named `NNNN-short-slug.md`, starting at `0001`.
- Each record uses a simple MADR-style template: Context, Decision, Consequences, Alternatives Considered.
- Records are additive. When a decision changes, add a new record that references and supersedes the previous one. Do not rewrite history.
- Records link back to the planning pack at `docs/planning/` so future contributors can reconstruct the reasoning chain.

## Scope

ADRs in this directory capture framework-level decisions. Package-local trade-offs that only affect one package belong in that package's README or an inline note, not here.

ADRs must be written when:

- A decision affects more than one package
- A decision affects the public framework shape (kernel contracts, SDK contracts, preset behavior, config layout)
- A decision rejects a reasonable alternative that a future contributor is likely to revisit
- A Linear issue explicitly asks for a decision record

## Current Records

- [`0001-monorepo-scaffold.md`](0001-monorepo-scaffold.md) — initial monorepo layout, package manager choice, and package granularity.
- [`0002-base-toolchain.md`](0002-base-toolchain.md) — base toolchain for the monorepo: Node LTS, TypeScript project references, Biome, Vitest, workspace scripts, and the four-command quality gate.
- [`0003-release-and-publishing.md`](0003-release-and-publishing.md) — release tool (changesets), independent versioning, public-vs-internal classification, `publishConfig` with npm provenance, changelog policy, and the CI/release-ownership handoff to `CTL-02` and `CTL-03`.
- [`0004-config-contracts-and-discovery.md`](0004-config-contracts-and-discovery.md) — Zod-backed config contracts, JSON Schema artifacts in `contracts/`, deterministic `.generic-ai/` discovery, and startup-time validation/composition.
- [`0004-sdk-contracts.md`](0004-sdk-contracts.md) — SDK-owned plugin, lifecycle, registry, storage, queue, workspace, output, and scope contracts plus the typed helper surface plugin authors build against.
- [`0005-plugin-host.md`](0005-plugin-host.md) — deterministic plugin-host ordering, lifecycle execution, and actionable host diagnostics inside `@generic-ai/core`.
- [`0005-starter-preset-contract.md`](0005-starter-preset-contract.md) — SDK-owned preset contracts, starter preset composition rules, and the kernel/preset boundary.
- [`0006-scope-primitive.md`](0006-scope-primitive.md) — the framework-wide `Scope` primitive and how it flows through bootstrap, runtime, and plugin execution.
- [`0007-session-orchestration.md`](0007-session-orchestration.md) — kernel-owned root/child session lifecycle and observability model.
- [`0008-canonical-event-stream.md`](0008-canonical-event-stream.md) — the canonical event taxonomy and streaming surface emitted by the kernel.
- [`0009-shared-run-modes.md`](0009-shared-run-modes.md) — shared session machinery for sync and async execution modes.
- [`0010-run-envelope.md`](0010-run-envelope.md) — the minimal stable run envelope the kernel returns before output plugins finalize payloads.
- [`0011-pi-direct-boundary.md`](0011-pi-direct-boundary.md) — direct `pi` exposure and the thin boundary Generic AI keeps around runtime/tool primitives.
- [`0012-bootstrap-api.md`](0012-bootstrap-api.md) - `createGenericAI()`, starter-preset defaulting, and config-aware bootstrap composition.
- [`0013-sandboxed-execution.md`](0013-sandboxed-execution.md) - Docker-backed sandbox execution, migration posture, and trade-offs.
- [`0014-runtime-governance-and-security-controls.md`](0014-runtime-governance-and-security-controls.md) - deferred runtime governance architecture: plugin-owned enforcement, a future shared SDK policy contract, and the least-privilege roadmap for terminal, file, and MCP capabilities.
- [`0015-ci-and-branch-control.md`](0015-ci-and-branch-control.md) - PR-time quality gate, docs-as-code check, and branch-protection expectations.
- [`0016-security-and-supply-chain-baseline.md`](0016-security-and-supply-chain-baseline.md) - security policy, CODEOWNERS, Dependabot, dependency audit posture, and deferred supply-chain controls.
- [`0017-agent-boundaries-ownership-task-discovery.md`](0017-agent-boundaries-ownership-task-discovery.md) - root agent instructions, ownership docs, issue forms, and PR template.
- [`0018-docs-as-code-baseline.md`](0018-docs-as-code-baseline.md) - deterministic generated package index and docs check workflow.
- [`0019-identity-auth-plugin-boundary.md`](0019-identity-auth-plugin-boundary.md) - deferred identity/auth architecture: plugin-owned auth, SDK-visible identity context, Hono adapter implications, and hosted-vs-local preset posture.
- [`0020-advanced-observability.md`](0020-advanced-observability.md) - deferred advanced observability architecture: baseline OTEL logs/traces stay separate from future metrics, dashboards, and product analytics.

## Planning Baseline

- `docs/planning/README.md`
- `docs/planning/01-scope-and-decisions.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
