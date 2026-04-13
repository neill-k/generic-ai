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
- `examples/` — runnable reference usage of the framework. `examples/starter-hono/` is the reference example that TRN-03 will build out.
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

Every contributor runs the same four commands locally before opening a pull request. CI will run the same four commands once [`CTL-02`](docs/planning/03-linear-issue-tree.md) wires it. Full contributor setup, per-command reference, and how to add new packages live in [`CONTRIBUTING.md`](CONTRIBUTING.md). The toolchain decisions and trade-offs are recorded in [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md).

## Releases

Generic AI uses [Changesets](https://github.com/changesets/changesets) for independent per-package semver, automated changelog generation, and npm publishing. Every publishable package under `packages/*` is scoped `@generic-ai/*` and ships with `publishConfig.access: "public"` plus `publishConfig.provenance: true`. The full release playbook (versioning rules, public-vs-internal classification, and the manual-until-CTL-02 cut path) lives in [`RELEASING.md`](RELEASING.md). The release-tool decision, trade-offs, and rejected alternatives are recorded in [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md). PRs that touch any publishable package should include a changeset — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the one-line recipe.

## Planned Surfaces

## Generic Core
Base framework

## Generic Base Plugins
Plugins installed by default

## Generic Security and Governance
Security and governance

## Generic TUI
TUI

## Generic Web UI
Web UI

## Generic Observability
Observability
