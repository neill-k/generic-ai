# Releasing Generic AI

This document is the release playbook for the Generic AI framework monorepo.
It captures the versioning strategy, the tool of choice, the public vs
internal package split, and the mechanics of cutting a release.

The formal decision is recorded in
[`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md).
This file is the operational companion to that ADR: the ADR captures the
"why," this file captures the "how."

- Planning baseline: [`docs/planning/README.md`](docs/planning/README.md)
- Package boundaries: [`docs/package-boundaries.md`](docs/package-boundaries.md)
- Contributor setup: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Monorepo scaffold ADR: [`docs/decisions/0001-monorepo-scaffold.md`](docs/decisions/0001-monorepo-scaffold.md)
- Base toolchain ADR: [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md)
- Release and publishing ADR: [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md)

## Versioning strategy

Generic AI follows [Semantic Versioning 2.0.0](https://semver.org/) for every
publishable package. The framework-specific interpretation of `MAJOR.MINOR.PATCH`
for Generic AI is:

- **MAJOR** — a breaking change in a published API. This includes:
  - any breaking change to `@generic-ai/core` kernel contracts;
  - any breaking change to `@generic-ai/sdk` types that plugin authors compile
    against;
  - any breaking change to a plugin's public contract (exports, config shape,
    or registered capability) that a preset or downstream consumer could have
    depended on;
  - any breaking change to the starter preset's composition that would
    silently change runtime behavior for an existing consumer.
- **MINOR** — a backwards-compatible capability change. New plugin exports,
  new optional config fields, new events in the canonical event stream, new
  hooks, new starter preset wiring that does not change existing behavior.
- **PATCH** — a backwards-compatible fix. Bugfixes, internal refactors that do
  not change public behavior, documentation updates that ship inside the
  published tarball.

Plugin authors who ship their own `@generic-ai/plugin-*` packages outside this
repo should follow the same interpretation so the plugin ecosystem's semver
expectations stay consistent.

### Fixed vs independent versioning

Generic AI uses **independent versioning**. Every publishable package carries
its own version and is bumped only when its own contents change (plus the
standard changesets behavior of bumping dependents whose internal
dependencies were bumped).

This is the changesets default: `fixed: []` and `linked: []` in
[`.changeset/config.json`](.changeset/config.json).

Rationale:

- Generic AI is plugin-first. Plugins are replaceable and designed to evolve
  at their own cadence. A fix in `plugin-storage-sqlite` should not force a
  version bump in `plugin-mcp` or `plugin-agent-skills`.
- Fixed versioning would mean every plugin's patch release walks the entire
  framework's version number forward, which inflates release noise and
  confuses downstream pin policy.
- Independent versioning composes cleanly with the package boundaries
  documented in [`docs/package-boundaries.md`](docs/package-boundaries.md):
  each package has a clear owner and a clear surface, so it can own its own
  version history.

Trade-off: consumers who want to upgrade "the framework" end up bumping
multiple packages at once. That is the price of plugin-first. The starter
preset exists partly to soften this: most users compose the framework through
`@generic-ai/preset-starter-hono`, which transitively pins compatible plugin
versions through its dependency tree.

We reserve the right to revisit with `linked` groups later if specific clusters
(for example, "kernel + sdk always move together") become painful under
independent versioning. Such a change would require a new ADR that supersedes
[`0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md).

## Public vs internal packages

Every package in this repo is explicitly classified.

### Public (published to npm)

All packages under `packages/*` are public, published to npm under the
`@generic-ai/` scope, and carry:

- `"private": false` in their `package.json`,
- `"publishConfig": { "access": "public", "provenance": true }` to force
  public access for a scoped package and to request npm provenance
  attestations when published from a trusted CI environment.

The complete public list:

| Package                               | Role                                        |
| ------------------------------------- | ------------------------------------------- |
| `@generic-ai/core`                    | kernel                                      |
| `@generic-ai/observability`           | local observability surface                 |
| `@generic-ai/sdk`                     | framework-facing SDK contracts              |
| `@generic-ai/preset-starter-hono`     | default starter preset                      |
| `@generic-ai/plugin-config-yaml`      | canonical YAML config plugin                |
| `@generic-ai/plugin-workspace-fs`     | local filesystem workspace services         |
| `@generic-ai/plugin-storage-memory`   | in-memory storage                           |
| `@generic-ai/plugin-storage-sqlite`   | SQLite-backed storage                       |
| `@generic-ai/plugin-queue-memory`     | in-process queue                            |
| `@generic-ai/plugin-logging-otel`     | logging and OTEL tracing                    |
| `@generic-ai/plugin-tools-terminal`   | local terminal tool                         |
| `@generic-ai/plugin-tools-terminal-sandbox` | sandboxed terminal tool                     |
| `@generic-ai/plugin-tools-files`      | local file tools                            |
| `@generic-ai/plugin-tools-web`        | web fetch and search tools                  |
| `@generic-ai/plugin-repo-map`         | repository map and orientation tools        |
| `@generic-ai/plugin-lsp`              | stdio LSP client tools                      |
| `@generic-ai/plugin-mcp`              | embedded MCP plugin                         |
| `@generic-ai/plugin-agent-skills`     | Agent Skills compatibility plugin           |
| `@generic-ai/plugin-delegation`       | delegation business-model plugin            |
| `@generic-ai/plugin-interaction`      | user-question and task-tracking tools       |
| `@generic-ai/plugin-messaging`        | durable storage-backed messaging            |
| `@generic-ai/plugin-memory-files`     | file-backed persistent memory               |
| `@generic-ai/plugin-output-default`   | default output and finalization plugin      |
| `@generic-ai/plugin-lsp`              | LSP client tools for harness runs           |
| `@generic-ai/plugin-repo-map`         | deterministic repository maps and orientation |
| `@generic-ai/plugin-web-ui`            | local-first web console plugin                |
| `@generic-ai/observability`           | local-first observability surface           |
| `@generic-ai/plugin-hono`             | official Hono integration plugin            |
| `@generic-ai/plugin-web-ui`           | local-first web console plugin              |

### Internal (never published)

- The root monorepo `package.json` (`@generic-ai/monorepo`) is marked
  `"private": true`. It is the workspace container; it must never be
  published.
- `examples/starter-hono/` (`@generic-ai/example-starter-hono`) is marked
  `"private": true`. It is a runnable reference example, not a published
  package. It is also listed in the `ignore` array of
  [`.changeset/config.json`](.changeset/config.json) as a belt-and-braces
  measure so changesets never considers it for versioning or publishing.
  Future examples added under `examples/*` should follow the same pattern.
- `contracts/` and `specs/` are top-level directories, not workspaces, and
  are not part of the npm publish surface.

If a new workspace is added under `packages/*`, it is public by default and
must carry the `publishConfig` block above. If a new workspace is added under
`examples/*`, it is private by default and must be listed in the changesets
`ignore` array.

## How to create a changeset

Any pull request that changes a file in `packages/*` in a way that affects a
published package's shape or behavior must include a changeset. The recipe:

```bash
npm run changeset
```

The interactive CLI will:

1. Ask which packages are affected (multi-select).
2. Ask for the bump type (`patch`, `minor`, or `major`) for each selected
   package, following the MAJOR / MINOR / PATCH definitions above.
3. Ask for a one- to two-sentence summary that will end up in the generated
   `CHANGELOG.md` for each affected package.

The result is a new Markdown file under `.changeset/`. Commit it alongside
the code change. Multiple changesets can accumulate between releases; the
next `changeset version` run consolidates them into version bumps and
per-package changelog entries.

If your change touches only files outside `packages/*` (for example,
documentation under `docs/`, the reference example under `examples/`, or
this file), no changeset is needed.

To verify the current pending state without creating anything, run:

```bash
npm run changeset:status
```

This prints the set of packages that are pending release, grouped by bump
type. Zero pending is a valid steady state.

## How releases are cut

Generic AI uses the two-phase changesets release flow. In the steady state
(once release automation has been wired on top of the baseline CI gate), the
flow is:

1. Contributors merge PRs that include changesets. Each merge lands the
   changeset file in `main` alongside the code change.
2. The changesets GitHub Action watches `main`. When it sees any pending
   changesets, it opens a "Version Packages" pull request that:
   - runs `changeset version`,
   - bumps affected packages,
   - rewrites internal dependency ranges,
   - regenerates each package's `CHANGELOG.md`,
   - updates `package-lock.json`.
3. A maintainer reviews and merges the Version Packages PR.
4. On merge, the changesets Action runs `changeset publish`, which publishes
   every package whose version is newer than what is already on npm. With
   OIDC configured, the publish runs with npm provenance attached.
5. The Action creates git tags for the published versions.

The repo has baseline pull-request CI, but it does not yet have an automated
release workflow that versions packages, publishes with provenance, and opens
or merges the generated changeset PR. Releases are manual, and the repo owner
is responsible for every release.

### Manual release path (until release automation lands)

Only the repo owner runs releases. The manual path:

```bash
# 1. Ensure main is clean, pulled, and the quality gate is green.
git checkout main
git pull --ff-only
npm install
npm run typecheck
npm run lint
npm run test
npm run build
npm run docs:check

# 2. Apply pending changesets.
npm run changeset:version

# 3. Review the result: package.json versions, CHANGELOG.md entries, and
# the updated package-lock.json. Commit the version bump to main.
git add -A
git commit -m "chore(release): version packages"
git push

# 4. Publish to npm. This runs `npm run build` first and then
# `changeset publish`, which pushes to the npm registry for every package
# whose local version is ahead of the registry.
#
# IMPORTANT: `publishConfig.provenance: true` is set on every public
# package, so a local `npm publish` without OIDC credentials will fail
# with "--provenance is not supported outside of a trusted CI environment".
# This is intentional: Generic AI does not publish from laptops. The
# manual path is only usable from a machine that has OIDC configured.
npm run changeset:publish

# 5. Tag the release in git (changesets publish does not tag by default
# in the manual path).
git tag -a "v$(date +%Y.%m.%d)" -m "Release $(date +%Y-%m-%d)"
git push --tags
```

The manual path is a stopgap. The intent is that a dedicated release workflow
eventually runs the publish step from trusted CI.

## npm provenance

All public packages declare `"publishConfig": { "provenance": true }`. This
flag asks npm to attach a provenance attestation to every published tarball.
Provenance binds the tarball to a specific git commit, a specific CI job, and
a specific build environment, using Sigstore's public transparency log. It
lets downstream consumers verify that a given npm package came from this
repo's CI, not from a compromised developer laptop.

### Prerequisites

Provenance is a CI-only feature. It requires:

- npm CLI >= 11.5.1 (the repo's `packageManager` pin of `npm@11.12.1`
  already satisfies this).
- Node >= 22.14.0 (the repo's `engines.node` pin of `>=24.0.0` already
  satisfies this).
- The publish command running inside a supported CI environment. In April
  2026 that means GitHub Actions or GitLab CI, on a cloud-hosted runner.
- OIDC trusted publishing configured on the npm side: the `@generic-ai`
  scope must be configured on npm to trust the GitHub repository and the
  specific workflow path that runs `changeset publish`.
- The GitHub Actions workflow must grant `permissions: { id-token: write }`
  on the publish job so the runner can obtain an OIDC token.

**What this means locally.** A developer running `npm publish` on their
laptop will hit "--provenance is not supported outside of a trusted CI
environment" and the publish will fail loudly. That is the intent: releases
are never cut from laptops, only from CI.

**What release automation owns.** A future release workflow configures:

- the GitHub Actions workflow that runs `changeset publish` on merge to
  `main`,
- `permissions: { id-token: write }` on the publish job,
- the npm trusted-publisher binding for the `@generic-ai` scope,
- secret rotation policy for any fallback `NPM_TOKEN` (ideally: none, because
  OIDC replaces it).

Until release automation lands, provenance is effectively "declared intent,
not enforced." The `publishConfig` block is still worth committing because
it fails fast and safely the moment someone tries to publish from a laptop.

## Changelog policy

Changesets generates one `CHANGELOG.md` per package. The format is a
minimal variant of [Keep a Changelog](https://keepachangelog.com/) with
entries grouped by version and by bump type. Contributors do not maintain
`CHANGELOG.md` files by hand. The `changeset version` step rewrites them.

The root repo does not carry a monorepo-wide `CHANGELOG.md` file. The npm
registry view for each package plus its per-package `CHANGELOG.md` is the
authoritative changelog. Downstream consumers should read the changelog of
the specific packages they depend on.

Historic context entries, research notes, and migration guidance belong in
prose documentation under `docs/`, not in generated changelogs.

## Release ownership

While the repo is pre-v1, the repo owner cuts every release. Release
ownership will be formalized under
[`CTL-03`](docs/planning/03-linear-issue-tree.md) (agent boundaries and
repo ownership). That issue will:

- name the release manager role (individual or rotating),
- define the escalation path when a release is blocked,
- document hotfix and rollback procedures.

Until `CTL-03` lands, contact the repo owner before cutting a release that
is not the normal changeset-driven patch flow.

## Pre-release channels

The framework does not currently ship pre-releases. The intent is to
support these npm dist-tags once there is meaningful code to gate behind
them:

- `next` — published from `main` for every merge that carries a changeset,
  using `changeset pre enter next` / `changeset pre exit`. Consumers who
  want the unreleased edge pin `@generic-ai/<pkg>@next`.
- `alpha` — unstable experimental work that is still changing shape.
- `beta` — feature-complete work that is waiting for final QA before
  becoming `latest`.

Pre-release channels are explicitly **not** used during the scaffolding
epics. Every package is pinned to `0.0.0` until the kernel and SDK
contracts land in Epic 1 (`KRN-*`). The first real publish will be a
`0.1.0` release cut from `main` after the Epic 1 contracts stabilize.

## Related planning and decision records

- Monorepo scaffold, package layout, and workspaces:
  [`docs/decisions/0001-monorepo-scaffold.md`](docs/decisions/0001-monorepo-scaffold.md)
- Base toolchain, quality gate, and devDep pins:
  [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md)
- Release and publishing conventions (this document's source of truth):
  [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md)
- Baseline CI and branch-control gates: [`docs/branch-protection.md`](docs/branch-protection.md) and [`docs/ci-and-branch-control.md`](docs/ci-and-branch-control.md)
- Release automation (blocks full release automation): `CTL-02`
- Release manager formalization and hotfix policy: `CTL-03`
- Security and software-supply-chain controls: `CTL-06`
