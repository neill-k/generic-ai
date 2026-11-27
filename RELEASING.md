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

All packages under `packages/*` are public and published under the `@generic-ai/` scope. Each one
carries the same publishing metadata, kept in line by `scripts/package-metadata.mjs` (run by
`npm run lint`; `npm run package:metadata` fixes drift):

- `"private": false` and `"publishConfig": { "access": "public", "provenance": true }`,
- `license: MIT` and a `LICENSE` file in the package folder (npm always packs it),
- `repository` (with `directory`), `homepage`, `bugs`, `keywords` and `engines.node >= 24`,
- an `exports` map. Packages that had only `main`/`types` got a single `"."` entry plus
  `"./package.json"`, so consumers cannot reach into private files.

The 38 public packages:

| Package | Role |
| --- | --- |
| `@generic-ai/agent` | native agent loop |
| `@generic-ai/ai` | provider-neutral model layer |
| `@generic-ai/autonomy` | long-running goals and autonomous mode |
| `@generic-ai/core` | kernel |
| `@generic-ai/extensions` | native runtime extensions and hooks |
| `@generic-ai/observability` | local observability surface |
| `@generic-ai/plugin-agent-skills` | Agent Skills compatibility |
| `@generic-ai/plugin-approvals` | owner approvals for outward actions |
| `@generic-ai/plugin-auth-identity` | single-owner auth and API tokens |
| `@generic-ai/plugin-config-yaml` | canonical YAML config |
| `@generic-ai/plugin-delegation` | durable delegation cascade |
| `@generic-ai/plugin-hono` | Hono integration |
| `@generic-ai/plugin-interaction` | user questions and task tracking |
| `@generic-ai/plugin-logging-otel` | logging and OTEL tracing |
| `@generic-ai/plugin-lsp` | LSP client tools |
| `@generic-ai/plugin-mcp` | MCP client |
| `@generic-ai/plugin-memory-files` | file-backed memory |
| `@generic-ai/plugin-messaging` | durable inter-agent messaging |
| `@generic-ai/plugin-output-default` | default output and finalization |
| `@generic-ai/plugin-queue-memory` | in-process queue |
| `@generic-ai/plugin-repo-map` | repository maps |
| `@generic-ai/plugin-secrets` | secrets vault and grants |
| `@generic-ai/plugin-storage-memory` | in-memory storage |
| `@generic-ai/plugin-storage-postgres` | Postgres storage, run store and queue |
| `@generic-ai/plugin-storage-sqlite` | SQLite storage, run store and queue |
| `@generic-ai/plugin-tools-documents` | document read and write tools |
| `@generic-ai/plugin-tools-files` | file tools |
| `@generic-ai/plugin-tools-terminal` | terminal tool |
| `@generic-ai/plugin-tools-terminal-sandbox` | Docker sandbox terminal tool |
| `@generic-ai/plugin-tools-web` | web fetch and search tools |
| `@generic-ai/plugin-web-ui` | web console |
| `@generic-ai/plugin-workspace-fs` | filesystem workspace services |
| `@generic-ai/preset-starter-hono` | default starter preset |
| `@generic-ai/resources` | skills and prompt templates |
| `@generic-ai/rlm` | persistent Python workspace tool (RLM) |
| `@generic-ai/sdk` | contracts plugins compile against |
| `@generic-ai/session` | sessions, compaction and retry |
| `@generic-ai/subagents` | subagents and agent messaging |
| `@generic-ai/tools` | native coding tools |

### Internal (never published)

- The root `package.json` (`@generic-ai/monorepo`) is `"private": true`.
- Everything under `apps/*` (the Generic Corp app) and `examples/*` is `"private": true` and listed
  in the `ignore` array of [`.changeset/config.json`](.changeset/config.json). The pack check fails
  if a workspace outside `packages/` is not private, or if a public package depends on a private one.
- `contracts/` and `specs/` are not workspaces and are not published.

A new workspace under `packages/*` is public by default: run `npm run package:metadata` to give it
the metadata above. A new workspace under `examples/*` or `apps/*` must be private and added to the
changesets `ignore` array.

## Checking the packages before a release

`npm run release:check` (after `npm run build`) proves the packages work the way an outside user
gets them, not through workspace links. To keep CI minutes down it does not run on every pull
request: the `package-pack-check` workflow runs it when a package manifest, the changesets config
or the release tooling changes (on pull requests and on `main`), and the `release` workflow runs
it before any publish. It can also be started by hand from the Actions tab.

1. Static checks: name, version, license, `publishConfig`, `repository.directory`, `engines`,
   `exports`, `files`, and that no public package depends on a private workspace or uses a
   `workspace:`/`file:` spec.
2. `npm pack` for every public package, then checks each tarball: the files `main`, `types` and
   `exports` point at are present, `LICENSE` and `README.md` are present, and no source folders,
   tests, tsconfig or build info leak in.
3. A plain `npm install` of all tarballs into an empty project (third-party dependencies come from
   the registry).
4. Every export subpath of every package is imported in Node.
5. One TypeScript file importing every subpath typechecks under `NodeNext` resolution.
6. The consumer smoke scripts in `scripts/pack-smoke/` run against the installed packages. Today
   that is a small multi-agent run with no model key: a lead agent spawns a subagent through
   `@generic-ai/subagents`, collects its answer and replies.

`node scripts/check-pack.mjs --static` runs only step 1; `--keep` keeps the temporary project.

## How to create a changeset

Any pull request that changes a published package's shape or behavior must include a changeset:

```bash
npm run changeset
```

Pick the affected packages, the bump type for each (MAJOR / MINOR / PATCH as defined above) and a
one- or two-sentence summary for the changelog. Commit the generated file under `.changeset/`.
Changes outside `packages/*` need no changeset. `npm run changeset:status` shows what is pending.

The first release is pinned by `.changeset/first-npm-release.md`, a `minor` bump for every public
package, so all of them go from `0.0.0` to `0.1.0` together the first time.

## How releases are cut

Releases run only from the `release` workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)). It has no push or schedule
trigger: someone starts it from the Actions tab and picks a mode.

| Mode | What it does | Needs |
| --- | --- | --- |
| `check` | Full quality gate, `release:check`, pending changesets, and a publish dry run (`npm publish --dry-run` for every version not on npm yet). Publishes nothing. | nothing |
| `version` | Runs the checks, then opens or updates the "Version packages" pull request: `changeset version` bumps versions, rewrites internal ranges, writes each `CHANGELOG.md` and updates the lockfile. | "Allow GitHub Actions to create and approve pull requests" in Settings > Actions > General |
| `publish` | Runs the checks, then `changeset publish` for every version not on npm yet, with provenance, and pushes the git tags. | run from `main`, the confirm box set to `publish`, and npm credentials |

Without npm credentials, without `publish` in the confirm box, or off `main`, the publish job
writes a notice saying why and stops with success. Nothing is published.

The normal cycle:

1. Pull requests merge with their changesets.
2. Run `release` in `version` mode and merge the "Version packages" pull request it opens.
3. Run `release` in `publish` mode from `main` with `publish` in the confirm box.

`npm run release:list` shows which package versions are not on npm yet; `npm run release:dry-run`
also dry-runs their publish. Neither publishes anything. Generic AI does not publish from laptops.

## Before the first publish (owner checklist)

These need the repo owner's own npm account and cannot be done by an agent:

1. **Claim the scope.** Create the npm organization `generic-ai` (free for public packages) at
   npmjs.com, owned by the maintainer's npm account. On 2026-11-26 the registry had no
   `@generic-ai` organization and no packages under the scope. If the name is taken, every package
   name has to change before publishing.
2. **Give CI credentials**, one of:
   - **First publish:** a granular access token with read and write access to the `@generic-ai`
     scope (and "bypass 2FA" for automation), saved as the repository secret **`NPM_TOKEN`**.
   - **After the first publish (preferred):** on npmjs.com, add a trusted publisher to each package
     (GitHub Actions, repository `neill-k/generic-ai`, workflow `release.yml`, environment
     `npm-publish`), set the repository variable **`NPM_TRUSTED_PUBLISHING=true`**, then delete the
     `NPM_TOKEN` secret and revoke the token.
3. **Optional last gate:** in Settings > Environments > `npm-publish`, add yourself as a required
   reviewer so every publish waits for a click.
4. Run `release` in `check` mode and read the dry-run output, then `version`, then `publish`.

## npm provenance

All public packages declare `"publishConfig": { "provenance": true }`, and the publish job grants
`id-token: write`. npm attaches a Sigstore provenance attestation that ties each tarball to the
commit and workflow run that built it. A `npm publish` from a laptop fails with "provenance is not
supported outside of a trusted CI environment", which is intended. It needs npm 11.5.1 or later
(the repo pins `npm@11.12.1`) and a GitHub-hosted runner.

## Deprecation policy

- Before 1.0, a MINOR bump may break a public API. The changeset must say what broke and how to
  migrate. After 1.0, breaking changes need a MAJOR bump.
- A public export that is going away is first marked `@deprecated` in its TSDoc, with the
  replacement, for at least one MINOR release before removal.
- A whole package that is retired gets a final release whose README points at the replacement,
  then `npm deprecate "@generic-ai/<name>@*" "<message>"`. Published versions are never
  unpublished; a broken release is fixed by publishing a new version and deprecating the bad one
  with `npm deprecate "@generic-ai/<name>@<version>" "<reason>"`.
- Node support follows `engines.node`. Raising the minimum Node major is a breaking change.

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

Pre-release channels are not used yet. The first real publish is `0.1.0` for every public package
(see "How to create a changeset"), cut from `main` once the native runtime is the default and
pi is removed. Until then the release workflow can be run in `check` mode at any time.

## Related planning and decision records

- Monorepo scaffold, package layout, and workspaces:
  [`docs/decisions/0001-monorepo-scaffold.md`](docs/decisions/0001-monorepo-scaffold.md)
- Base toolchain, quality gate, and devDep pins:
  [`docs/decisions/0002-base-toolchain.md`](docs/decisions/0002-base-toolchain.md)
- Release and publishing conventions (this document's source of truth):
  [`docs/decisions/0003-release-and-publishing.md`](docs/decisions/0003-release-and-publishing.md)
- Baseline CI and branch-control gates: [`docs/branch-protection.md`](docs/branch-protection.md) and [`docs/ci-and-branch-control.md`](docs/ci-and-branch-control.md)
- Release automation: [`.github/workflows/release.yml`](.github/workflows/release.yml) (`CTL-02`, roadmap R21)
- Release manager formalization and hotfix policy: `CTL-03`
- Security and software-supply-chain controls: `CTL-06`
