# 0002 — Base toolchain for the Generic AI monorepo

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-306` (FND-03)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md`
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/planning/04-agent-ready-mapping.md`
  - `docs/package-boundaries.md`
  - `docs/decisions/0001-monorepo-scaffold.md`

## Context

FND-02 landed the monorepo scaffold: 18 framework packages under `packages/`, an `examples/` tree, frozen top-level `contracts/` and `specs/` directories, and a minimal root `package.json` declaring npm workspaces. Every package ships a `package.json` that points `main`/`types` at `dist/` and a single-line placeholder `src/index.ts`, but the scaffold was deliberately left without a build step, a type system config, a linter, a formatter, a test runner, or a contributor setup path.

FND-03 has to fix that. Plugin work across multiple epics (`KRN-*`, `CFG-*`, `INF-*`, `CAP-*`, `TRN-*`) will fan out quickly once the kernel contracts land in `KRN-01`. Those parallel tracks need one credible, shared local and CI toolchain before they start, otherwise every plugin author will re-solve "how do I build, typecheck, lint, test, and format this package" in a slightly different way and we lose the plugin-first guarantees that the planning pack is built around.

The agent-ready mapping in `docs/planning/04-agent-ready-mapping.md` also pins several `Phase 1` checks to FND-03 specifically: `style.editorconfig`, `style.linter_config`, `style.type_checking`, `build.scripts`, `build.lock_file`, `test.config`, and `security.gitignore`. This ADR captures the toolchain choices that make those checks satisfiable.

We also need to be clear about what FND-03 does **not** own:

- CI, branch protection, and required checks: `CTL-02`.
- Pre-commit hook installation (Husky, lefthook, lint-staged): `CTL-02`.
- Generated API documentation and docs-as-code: `CTL-04`.
- Release automation, changesets, publishing, public-vs-internal decisions: `NEI-307` (FND-04).
- Real kernel/SDK/plugin source code: every `KRN-*`, `CFG-*`, `INF-*`, `CAP-*`, and `TRN-*` issue that follows.

## Decision

### Node LTS baseline: Node 24

Pin Node 24 via `.nvmrc` and `engines.node: ">=24.0.0"` in the root `package.json`. Node 24 is the active primary LTS in April 2026. Node 20 reaches end-of-life on 2026-04-30, so adopting it now would require an immediate migration. Node 22 is in maintenance LTS and still supported, but the framework is brand new, has no existing Node 22 users to preserve, and every direct devDependency we pick (Vitest 4, Biome 2.4, TypeScript 6) either already requires or happily supports Node 24.

### Package manager: npm 11 pinned via `packageManager`

Keep npm workspaces (the FND-02 scaffold choice) and pin `packageManager: "npm@11.12.1"` in the root `package.json`. Corepack honors this pin and gives FND-04 and CTL-02 a stable baseline that does not shift between contributors. This extends ADR 0001 rather than overturning it; see "Alternatives Considered" below for the pnpm question.

### Build tool: TypeScript project references via `tsc --build`

Use `tsc -b` as the only build and typecheck entrypoint. Every package extends a single root `tsconfig.base.json` and carries its own `tsconfig.json` with `composite: true`, so the workspace is one TypeScript project graph. The root `tsconfig.json` has `files: []` and a `references` array listing every package, so `tsc -b` can drive the whole workspace in dependency order without a task runner.

`tsconfig.base.json` is deliberately strict for a public framework:

- `target: "ES2024"`, `lib: ["ES2024"]`, `module: "NodeNext"`, `moduleResolution: "NodeNext"` — Node 24 supports ES2024 natively and NodeNext is the only module setting that honors `package.json` exports on real Node runtimes.
- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `noPropertyAccessFromIndexSignature` — all the non-default strictness flags we want on from day one, because turning them on later is expensive.
- `verbatimModuleSyntax: true`, `isolatedModules: true`, `esModuleInterop: true`, `forceConsistentCasingInFileNames: true` — these make the emit match what real runtimes and bundlers expect and keep `import type` discipline honest across plugin boundaries.
- `composite: true`, `incremental: true`, `declaration: true`, `declarationMap: true`, `sourceMap: true` — required for project references and for downstream consumers who want to jump from `.d.ts` back into source.
- `outDir: "dist"`, `rootDir: "src"` — every package emits to its own `dist/` so the `main`/`types` pointers the scaffold wrote in FND-02 resolve without any further configuration.

We do **not** add a separate bundler (tsup, tsdown, unbuild, rollup, esbuild) in this phase. The framework packages are plain Node ESM libraries; they do not need tree-shaking, CJS fallback, or browser output right now. Adding a bundler today would lock in a choice we do not yet need. FND-03 keeps the door open for a future bundler by leaving the emit shape controllable at the tsconfig layer.

### Linter and formatter: Biome 2.4

Use Biome 2.4 as the single source of truth for linting and formatting across the whole repo, wired through `biome.json` at the root. Biome's 2026 story is:

- One binary instead of ESLint + Prettier + dozens of plugins.
- v2 shipped type-aware lint rules, closing the historical `@typescript-eslint` gap.
- 10–25x faster than ESLint+Prettier on real codebases, which matters for CI time and for the pre-commit path CTL-02 will add later.
- Respects `.editorconfig` and `.gitignore` natively.

The `biome.json` enables the recommended ruleset plus targeted complexity, correctness, and style rules (`noUnusedImports`, `noUnusedVariables`, `useNodejsImportProtocol`, `useConst`, `useTemplate`, `noParameterAssign`, `noUselessElse`). `noExplicitAny` is set to `warn` so the FND-03 placeholder sources lint cleanly while still nudging real code in the right direction. Formatter config matches `.editorconfig`: 2-space indent, LF line endings, double quotes, trailing commas, semicolons.

Rejected for the reasons captured in "Alternatives Considered": ESLint + Prettier + typescript-eslint, Oxlint, dprint standalone.

### Test runner: Vitest 4

Use Vitest 4 as the single workspace test runner, driven by `vitest.config.ts` at the root. Vitest 4:

- Requires zero configuration to run TypeScript ESM on Node 24.
- Handles the workspace natively by globbing `packages/*/src/**/*.{test,spec}.{ts,tsx}` and `packages/*/test/**/*.{test,spec}.{ts,tsx}`.
- Supports `passWithNoTests: true`, so the workspace test script exits cleanly while packages are still placeholder-only.
- Is the 2026 default for new TypeScript projects and for monorepos that need a fast feedback loop.

We do **not** adopt Vitest's browser mode, visual regression, or Playwright integration in FND-03. Those stay available for later capability work.

### Docs generator: deferred placeholder

The `docs` npm script exists, is callable, and currently prints `"TODO: CTL-04 will implement docs generation"` before exiting zero. The architecture doc already owns docs-as-code and generated API docs under `CTL-04`. FND-03 simply guarantees that the script exists so CI and contributors can rely on the shape.

### Editor config, gitignore, and nvmrc

- `.editorconfig` pins UTF-8, LF, 2-space indent, trim trailing whitespace (except in Markdown), final newline.
- `.nvmrc` pins `24`.
- `.gitignore` ignores `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/`, common cache directories, `.env*` files, editor and OS junk. It does not ignore `.editorconfig`, `.nvmrc`, source, or the lockfile.

### Workspace scripts

The root `package.json` exposes exactly these scripts:

- `build` — `tsc -b`
- `typecheck` — `tsc -b --noEmit --pretty`
- `test` — `vitest run`
- `lint` — `biome lint .`
- `format` — `biome format --write .`
- `format:check` — `biome format .`
- `docs` — `node -e "console.log('TODO: CTL-04 will implement docs generation')"`
- `clean` — `rimraf "packages/*/dist" "packages/*/*.tsbuildinfo" "examples/*/dist" node_modules`

`rimraf` is the only non-ecosystem devDependency; it exists purely because `clean` must be portable across POSIX shells and Windows cmd, and PowerShell's `Remove-Item` does not round-trip glob semantics.

### devDependencies (pinned exact versions)

Every devDependency is pinned to an exact version rather than a floating range. FND-04 will revisit whether devDeps should live at the root only or also per-package once release automation is in place; for now the scaffold keeps them at the root to minimize the fan-out surface.

- `typescript@6.0.2`
- `@types/node@24.12.2`
- `@biomejs/biome@2.4.11`
- `vitest@4.1.4`
- `rimraf@6.1.3`

## Consequences

### Positive

- Every contributor and every agent has exactly one way to build, typecheck, lint, format, and test the entire workspace. The four-command quality gate (`typecheck`, `lint`, `test`, `build`) is the same locally and, once `CTL-02` lands CI, in GitHub Actions.
- New packages added during KRN/CFG/INF/CAP/TRN only need to copy an existing `packages/<name>/tsconfig.json`, add themselves to the root `tsconfig.json` references, and they immediately participate in every quality gate.
- Strict TypeScript flags are on from day one, before any real source code exists. Turning these on later would mean a noisy migration sweep across every plugin.
- Biome gives us a single tool, single config file, single binary surface. CI time stays small and pre-commit hook wiring (owned by `CTL-02`) will be trivial because there is nothing to stitch together.
- Vitest's `passWithNoTests` keeps the test command honest while the scaffold is still empty, so `test.config` (`agent-ready`) is already satisfied on paper.
- Lockfile (`package-lock.json`) lands in this change, satisfying `build.lock_file`.
- `.gitignore`, `.editorconfig`, strict TypeScript, and Biome lint rules together cover `style.editorconfig`, `style.linter_config`, `style.type_checking`, and `security.gitignore` from `agent-ready`.

### Negative or to-be-paid

- Biome v2 still cannot express per-directory lint rule overrides as richly as ESLint's layered config model. If a single package later needs a custom rule set, we will either open a Biome feature request, use per-file overrides, or accept that one package runs with the root ruleset. We are explicitly choosing that trade-off for now because no package needs per-directory overrides yet.
- `tsc -b` is noticeably slower than a bundler-based pipeline (tsup, esbuild) on cold builds. We accept that because (a) the packages are still placeholder-sized, (b) incremental rebuilds are fast, and (c) adding a bundler now would lock in emit shape choices we do not yet need. If cold build time becomes a real problem, revisit in a follow-up ADR.
- Node 24 is still inside its LTS maturation curve. A few ecosystem libraries we have not adopted yet may not yet advertise Node 24 compatibility. We accept this because every devDependency we picked in this ADR already supports Node 24, and because Node 22 would cost us the ability to adopt Node 24-only APIs for the eventual durable messaging and memory plugins.
- Pinning to exact versions (rather than semver ranges) means devDependency upgrades are a manual, reviewable action. That is the point: this is the baseline, not a drift surface.
- We made the intentional decision not to install Husky/lefthook/lint-staged. Until `CTL-02` lands, contributors have to run the four-command quality gate by hand. `CONTRIBUTING.md` documents this expectation explicitly.

### What FND-03 does NOT do

- **CI, branch protection, required checks** — owned by `CTL-02`. The workspace scripts exist so CTL-02 can invoke them directly.
- **Pre-commit hook framework (Husky, lefthook, lint-staged)** — owned by `CTL-02`.
- **Generated API documentation** — owned by `CTL-04`. The `docs` script is a placeholder.
- **Release automation, changesets, semver policy, public-vs-internal package decisions** — owned by `NEI-307` (FND-04).
- **Real kernel, SDK, or plugin source** — owned by the KRN, CFG, INF, CAP, TRN epics.
- **Contract and spec tooling** — owned by `KRN-01`, `CFG-01`, `CTL-04`, `CTL-05`.
- **Security hygiene beyond `.gitignore`** (Dependabot, CODEOWNERS, SAST, SBOM) — owned by `CTL-06`.

## Alternatives Considered

### Build tool

- **tsup (esbuild-based).** Faster cold builds, ESM+CJS dual output out of the box. Rejected for FND-03 because we are pure ESM, do not need dual output, and do not want to lock in an emit shape before the kernel contracts exist. Tsup's project-reference story is also weaker than `tsc -b`'s.
- **tsdown (rolldown-based).** Ecosystem is still consolidating in early 2026 and the feature set is evolving. Rejected as too immature for a brand-new framework's baseline.
- **unbuild.** Heavier defaults than we need and assumes a bundler mindset. Rejected for the same reason as tsup.
- **rollup directly.** Maximum flexibility, maximum configuration cost. Rejected as overkill for flat ESM library output.

### Linter and formatter

- **ESLint 9 + Prettier + typescript-eslint.** Still the safest default if we needed the deepest plugin ecosystem (Vue, Angular, framework-specific rules). Rejected because we do not need any of that, Biome v2 closed the type-aware rule gap, and we value the 10-25x speed advantage and the single-binary deployment story for CI and pre-commit hooks.
- **Oxlint.** Faster than Biome for pure linting, but does not format. We would have to reintroduce Prettier or dprint alongside it, giving up Biome's "one tool" win. Rejected.
- **dprint standalone.** Formatter only. Rejected for the same reason as Oxlint.

### Test runner

- **Jest 30.** Mature, huge ecosystem. Rejected because it still requires non-trivial ESM configuration and is slower than Vitest on TypeScript ESM. Vitest is the 2026 default for new TypeScript projects.
- **node:test (the built-in Node runner).** Zero dependencies, ships with Node. Rejected because it lacks watch mode, snapshot testing, workspace-aware globbing, and the DX that Vitest provides out of the box. We revisit if Vitest becomes a burden.

### Package manager

- **pnpm workspaces.** Widely described as the 2026 default for strict TypeScript monorepos, with faster installs and a stricter dependency graph. This ADR keeps npm for FND-03 because (a) ADR 0001 already picked npm, (b) switching mid-scaffold would be wasted motion, and (c) we have no concrete pain yet that pnpm would solve. FND-04 or a later ADR can revisit if strict dependency resolution, task caching, or install performance become real problems.
- **Bun workspaces.** Very fast but still less widely adopted in framework-repo CI pipelines. Rejected to keep the baseline conservative.
- **Yarn v4.** Comparable feature set to npm workspaces. Rejected as no concrete benefit over npm at this phase.

### Docs generator

- **TypeDoc.** The obvious choice for TypeScript API docs. Deferred to `CTL-04` because docs-as-code is explicitly owned by CTL-04, and installing TypeDoc now would anchor a tool choice that CTL-04 should make when it has the full picture (generated API docs, prose docs, docs-site publishing).
- **Microsoft API Extractor.** Heavier, more ceremony, aimed at library-API-surface freezing. Also deferred to `CTL-04`.

## Research notes

Short summary of what the pre-ADR research (see search trail in the NEI-306 decision log comment) surfaced:

- 2026 TypeScript monorepo guidance consistently recommends TypeScript project references (`tsc -b`) as the build entrypoint for library-style workspaces, with `composite: true` and per-package `tsconfig.json` that extend a shared base. Adding a bundler or a task runner on top is framed as something to do when you have real build tasks to orchestrate, not as a prerequisite.
- Biome is described across multiple 2026 sources as the default 2026 choice for new TypeScript projects, with v2 closing the type-aware lint gap that historically kept teams on ESLint+typescript-eslint. ESLint remains the safe conservative choice for teams that rely on Vue/Angular/framework plugins; Generic AI does not.
- Vitest is described as the default 2026 TypeScript test runner, with multi-x speedups over Jest 30 and out-of-the-box ESM+TS support. `node:test` is competitive only for very small Node CLIs and pure Node libraries with no DX needs.
- Node 24 is the current primary LTS in April 2026. Node 20 reaches end-of-life on 2026-04-30.
- Pinning `packageManager` in `package.json` is the 2026 mainstream way to keep contributors and CI on the same package-manager version without wrestling with global installs.

No single source is cited as normative; these are trends confirmed across multiple 2026 blog posts, framework repositories, and tool documentation sampled before writing this ADR. The Linear comment on `NEI-306` carries a short decision log.
