# 0001 — Monorepo scaffold, package manager, and package granularity

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-305` (FND-02)
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/package-boundaries.md`

## Context

FND-02 asks for the authoritative repo layout for the Generic AI framework. The planning pack mandates a plugin-first architecture: a minimal kernel, a framework-facing SDK, many replaceable base plugins, a starter preset, and a reference example. The planning pack also fixes the per-package list and the top-level directories (`packages/`, `examples/`, `contracts/`, `specs/`, `docs/`).

We need to pick a physical layout, a package manager, and a package granularity that match those planning decisions without locking us into toolchain choices that FND-03 and FND-04 should own.

The decision below is deliberately minimal. FND-03 will add TypeScript, build tooling, lint, test, and editor config. FND-04 will add release automation and finalize public-vs-internal package assumptions. This ADR only covers the scaffold itself.

## Decision

### Monorepo (not poly-repo)

Generic AI is shipped as a single monorepo at `C:\Users\neill\code\generic-ai\` using workspaces. All framework packages, the starter preset, and the reference example live together in one repo. Contracts and specs are first-class top-level directories.

### Directory layout

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
  decisions/
  package-boundaries.md
```

The package list matches `docs/planning/02-architecture.md` exactly. `examples/` is a workspace glob alongside `packages/*` so the reference example can depend on published-shaped packages without special handling. `contracts/` and `specs/` are top-level because the planning pack treats them as first-class artifacts distinct from prose documentation.

### Package manager: npm workspaces at this phase

We use npm workspaces at the FND-02 scaffold phase. Every package is declared inside the root `package.json` via the `workspaces` field, and every package carries its own `package.json` with scope `@generic-ai/<dir>`.

Rationale:

- npm workspaces ship with the tool everyone already has. No extra install step is required just to clone and inspect the repo.
- npm workspaces cover exactly what FND-02 needs: workspace globs, symlinked local packages, and per-package manifests. FND-02 explicitly forbids adding build, test, or lint tooling, so the extra features pnpm, Yarn, or Nx would bring are not yet useful.
- The package manifest layout we wrote is portable across npm, pnpm, Yarn, and Bun workspaces. Moving to pnpm later is a root-level change, not a per-package rewrite.
- FND-03 is allowed to revisit this decision when it wires up the toolchain. This ADR stays narrow: "the cheapest viable workspace manager at the moment we introduce a scaffold."

Rejected alternatives:

- **pnpm workspaces + Turborepo**. Widely recommended as the 2026 default for TypeScript monorepos. Would give us faster installs, a stricter dependency graph, and caching. Rejected at FND-02 because we cannot install anything yet; we have no lockfile; and we have no build tasks to cache. Revisit in FND-03 if a strict dependency graph and task caching become concrete needs.
- **Yarn (classic or v4) workspaces**. Comparable feature set to npm, plus Plug'n'Play. Adds a tool choice without a concrete benefit at this phase.
- **Nx**. Powerful for large monorepos with many generators and an opinionated task graph. Rejected as over-tooling for a framework scaffold. We do not yet have enough packages with enough build steps to justify the configuration burden. Can be layered on top of npm workspaces later if needed.
- **No workspaces at all**. Rejected. The planning pack calls out many packages that share contracts and evolve together. Losing workspace linking at the scaffold stage would make every later issue harder.

### Granularity: one package per plugin

Every base plugin gets its own `packages/plugin-*/` directory and its own `package.json`. There is no "combined plugins" package.

Rationale:

- The planning pack already enumerates the plugins individually and says they must be replaceable.
- A single combined plugin package would force consumers to install all plugins even when they only need one, which undermines the plugin-first design goal.
- Versioning and release surfaces work better when one plugin is one publishable unit. Consumers pin per plugin.
- Tests, documentation, and contracts are easier to scope to a single plugin when the plugin has its own package boundary.

Rejected alternative: **one combined `@generic-ai/plugins` package, with subpaths per plugin**. Cheaper in directory count but locks every plugin's version, release cadence, and dependency graph together. Rejected.

### Package granularity: core and sdk stay separate

`@generic-ai/core` and `@generic-ai/sdk` are separate packages. This reinforces the layering rule in `docs/package-boundaries.md`: plugins compile against the SDK, never directly against the kernel.

Rejected alternative: **fold the SDK into `@generic-ai/core`**. Easier to maintain in the short term, but it means plugins effectively import from the kernel, which re-couples them to kernel internals. Rejected because it undermines the plugin-first architecture.

### Starter preset lives under `packages/`, example lives under `examples/`

The starter preset is `@generic-ai/preset-starter-hono` under `packages/`. The runnable example is `examples/starter-hono/`. They are intentionally separate: the preset is a composable package callers can depend on programmatically, while the example is a runnable illustration aimed at humans.

Rejected alternative: **ship only one thing, either the preset or the example**. Rejected because the planning pack explicitly requires both: the starter preset is part of the framework public surface, and the reference example exists to prove the stack end-to-end under `TRN-03`.

### Contracts and specs directories

`contracts/` and `specs/` are top-level, not nested under `docs/` or a package. They host artifacts distinct from prose planning and distinct from implementation code. `KRN-01`, `CFG-01`, `CTL-04`, and `CTL-05` will populate them.

Rejected alternative: **nest them inside `docs/`**. Rejected because `docs/` is prose-first; the planning pack separates contracts and specs from prose on purpose.

### What is intentionally not in this ADR

- Build output shape, `tsconfig`, or TypeScript project references — deferred to FND-03.
- Release automation, changesets, and `private` vs `public` decisions per package — deferred to FND-04. All packages currently declare `private: false` and point `main`/`types` at `dist/` placeholders so FND-04 can finalize the publishability story without rewriting the scaffold.
- The kernel and SDK source shapes — deferred to the KRN epic.

## Consequences

Positive:

- New contributors can clone the repo and immediately see which packages exist, where they live, and what they are responsible for.
- The package list already matches the planning architecture and the Linear issue tree, so later epics can land packages in their expected homes without re-scaffolding.
- The package-per-plugin layout keeps replacement and versioning honest.
- npm workspaces let us scaffold without committing to a specific future toolchain, and the layout is portable if FND-03 decides to switch package managers.

Negative or to-be-paid:

- Using npm workspaces now means we will likely run FND-03 research on whether to migrate to pnpm for performance and stricter dependency resolution. The migration cost is low because package manifests and workspace globs transfer cleanly.
- Carrying `main`/`types` fields that point at `dist/` before any build exists means editors will show unresolved paths until FND-03 lands. Acceptable trade-off to keep the scaffold honest about what publishable packages should declare.
- Every plugin package carries its own README, its own `package.json`, and its own `src/index.ts`. That is a one-time directory-count cost; it pays off as soon as the kernel and SDK contracts exist.

## Alternatives Considered

Summarized above per decision. The four concrete rejected alternatives are: pnpm+Turborepo, Yarn workspaces, Nx, and a combined plugin package. All four remain open for FND-03 and FND-04 to revisit, and this ADR records the reasons they are not appropriate right now.

## Research notes

Brief summary of the web research that informed this ADR:

- 2026 guidance consistently recommends workspaces (any package manager) over TypeScript path aliases, because workspaces leverage native Node resolution and portable `exports` fields. That supports the decision to use workspaces at all.
- pnpm is widely described as the strongest 2026 default for TypeScript monorepos when performance and strict dependency graphs matter. That supports revisiting in FND-03 rather than in FND-02.
- Turborepo and Nx are described as strongest when there are many build and test tasks to orchestrate and cache. FND-02 has no such tasks yet, so layering either on now would be premature.
- Framework repositories that expose many plugins generally favor one-package-per-plugin over a combined package, for versioning and replacement reasons. That supports the per-plugin decision.
- 2026 TypeScript monorepo guides generally separate apps/examples from shared packages, often with an `examples/` or `apps/` directory alongside `packages/`. That matches the `examples/starter-hono/` placement.

No single source is cited as normative; these are trends confirmed across multiple 2026 blog posts, monorepo guides, and framework repositories that were sampled before writing this ADR.
