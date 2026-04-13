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

## Planning Baseline

- `docs/planning/README.md`
- `docs/planning/01-scope-and-decisions.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
