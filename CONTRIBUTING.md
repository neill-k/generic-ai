# Contributing to Generic AI

Generic AI is a plugin-first multi-agent framework reimplementation. Before you change anything, read the planning pack and the package boundaries document so your change lands in the right place.

- [`docs/planning/README.md`](docs/planning/README.md) and the four numbered planning docs it links to.
- [`docs/package-boundaries.md`](docs/package-boundaries.md) for the per-package role and allowed-dependency matrix.
- [`docs/decisions/`](docs/decisions/) for architecture decision records. FND-03's toolchain decisions live in [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md).

## Prerequisites

- **Node.js 24 LTS.** The repo pins `24` in [`.nvmrc`](.nvmrc). Use `nvm use` (or your Node version manager of choice) to switch to it. Any Node 24.x release works; the `engines.node` field in `package.json` enforces `>=24.0.0`.
- **npm 11.** The repo pins `npm@11.12.1` via the `packageManager` field. Corepack will honor that pin automatically. Other package managers (pnpm, Yarn, Bun) may work for local experimentation but are not supported by the workspace scripts.
- **git.** Required for the Biome VCS integration that respects `.gitignore` during lint and format.

## Clone and install

```bash
git clone <repo-url> generic-ai
cd generic-ai
nvm use            # reads .nvmrc and selects Node 24
npm install        # installs workspace devDependencies and links all packages
```

`npm install` creates the lockfile and the root `node_modules/`. Every package in `packages/*` is linked via npm workspaces, so local changes propagate immediately without re-linking.

## The full quality gate

Run these commands before every pull request. The [`baseline-quality-gate`](.github/workflows/baseline-quality-gate.yml) workflow runs typecheck, lint, test, and build for pull requests and pushes to `main`; the separate [`Docs as Code`](.github/workflows/docs.yml) workflow runs `docs:check`:

```bash
npm run typecheck   # tsc -b --pretty across all project references, then clean build artifacts
npm run lint        # package boundaries, Biome helper-ignore regression, then scoped Biome lint
npm run test        # vitest run (passWithNoTests, exits 0 when empty)
npm run build       # tsc -b produces dist/ for every package
npm run docs:check  # verify generated docs are current
```

Additional local scripts you will likely use:

```bash
npm run format          # biome format --write .
npm run format:check    # biome format . (fails if anything would change)
npm run docs            # regenerate docs/generated/package-index.md
npm run clean           # remove dist, tsbuildinfo, and node_modules
```

If one of the quality-gate commands fails, fix the root cause before pushing. Never bypass a failing gate.

## Lint scope and local helper directories

`npm run lint` intentionally lints first-party roots only: the top-level docs/config files, `docs/`, `packages/`, `examples/`, and `scripts/`. It also runs `npm run check:biome-helper-ignores`, which creates temporary nested `biome.json` configs under ignored local-helper paths and runs Biome with VCS ignores disabled. That regression check proves the root `biome.json` excludes helper/worktree state directly instead of relying only on `.gitignore`.

Keep local agent/helper worktrees such as `.claude/`, `.codex/`, `.agents/scratch/`, and `.agents/worktrees/` out of tracked source. If a new local helper directory becomes common, add it to both `.gitignore` and the negative `files.includes` patterns in `biome.json` so direct Biome runs do not load nested configs from ambient local state.

## Where code lives

Package responsibilities and allowed dependencies are documented in [`docs/package-boundaries.md`](docs/package-boundaries.md). The short version:

- `@generic-ai/core` — kernel. Bootstrap, plugin host, registries, scope, sessions, events, run envelope. Depends on `pi` and `@generic-ai/sdk`.
- `@generic-ai/sdk` — framework-facing contracts plugin authors compile against.
- `@generic-ai/plugin-*` — replaceable base plugins. Depend on `@generic-ai/sdk`, not on the kernel.
- `@generic-ai/preset-starter-hono` — default starter preset that composes the local-first working stack.
- `examples/*` — runnable reference usage of the framework.

If you are adding a new package, copy an existing one:

1. Duplicate a peer directory under `packages/` (for example, `packages/plugin-storage-memory/`).
2. Update the new package's `package.json`: `name`, `description`, and any package-specific metadata. Keep `main`, `types`, `files`, `type`, `license`, `private`, and `publishConfig` identical to the template so the new package inherits the public access and npm provenance intent from [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md).
3. Update `src/index.ts` with the new package's placeholder export and replace `README.md` with a description that links back to the planning pack.
4. Add the new package to the `references` array in the root [`tsconfig.json`](tsconfig.json) so `tsc -b` picks it up.
5. Run the full quality gate to confirm the workspace still builds.

Packages under `examples/*` follow the opposite template: they carry `"private": true` and are excluded from the changesets release surface. See [`examples/starter-hono/package.json`](examples/starter-hono/package.json) for the shape to copy.

## Pre-commit expectations

Before opening a pull request, the full quality gate must pass locally. That means:

- `npm run typecheck` is green.
- `npm run lint` is green.
- `npm run test` is green.
- `npm run build` is green.
- `npm run docs:check` is green.

At this phase the repo does not install any pre-commit hook framework (Husky, lefthook, lint-staged). Local hook installation remains deferred under [`CTL-02`](docs/planning/03-linear-issue-tree.md), so honor the gate manually before pushing.

Pull request enforcement is handled by GitHub Actions and the `main` branch-protection rule documented in [`docs/branch-protection.md`](docs/branch-protection.md). If a fork or temporary repository does not have that protection enabled, do not merge until the baseline and docs checks have run and passed in the PR UI.

## Changesets

Generic AI uses [Changesets](https://github.com/changesets/changesets) to manage per-package versions, changelogs, and npm publishing. Any pull request that changes a publishable package under `packages/*` in a way that affects its shape or behavior must include a changeset.

The one-line recipe:

```bash
npm run changeset
```

The interactive CLI will ask which packages are affected, which semver bump type applies (`patch`, `minor`, `major`), and for a one-to-two-sentence summary that lands in that package's generated `CHANGELOG.md`. Commit the new file under `.changeset/` alongside your code change.

- Docs-only changes, example-only changes (`examples/*`), or internal-only edits (CI config, planning docs) do not need a changeset.
- Multiple changesets can accumulate between releases; they are consolidated automatically when a release is cut.
- `npm run changeset:status` prints the set of pending changesets without side effects.

Full release playbook, including versioning rules and the public-vs-internal package classification, lives in [`RELEASING.md`](RELEASING.md). The tool choice and trade-offs are captured in [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md).

## Raising a decision

If your change crosses a package boundary, rejects a reasonable alternative, or affects the public framework shape, write an ADR under [`docs/decisions/`](docs/decisions/) using the numbered MADR-style template. See [`docs/decisions/README.md`](docs/decisions/README.md) for the rules.

## Related reading

- Toolchain decision record: [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md)
- Monorepo scaffold decision record: [`docs/decisions/0001-monorepo-scaffold.md`](docs/decisions/0001-monorepo-scaffold.md)
- Release and publishing decision record: [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md)
- Release playbook: [`RELEASING.md`](RELEASING.md)
- Planning pack entrypoint: [`docs/planning/README.md`](docs/planning/README.md)
