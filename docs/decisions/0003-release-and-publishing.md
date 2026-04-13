# 0003 — Release and publishing conventions

- Status: accepted
- Date: 2026-04-13
- Linear: `NEI-307` (FND-04)
- Supersedes: none
- Related planning docs:
  - `docs/planning/01-scope-and-decisions.md` (see the "Repo-Control And
    Compliance Decisions" section)
  - `docs/planning/02-architecture.md`
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/planning/04-agent-ready-mapping.md`
  - `docs/package-boundaries.md`
  - `docs/decisions/0001-monorepo-scaffold.md`
  - `docs/decisions/0002-base-toolchain.md`
- Related release playbook:
  - `RELEASING.md`

## Context

`FND-01` through `FND-03` landed the repo's planning baseline, the 18-package
monorepo scaffold, and the shared TypeScript/Biome/Vitest toolchain. Every
package under `packages/*` already declares `"private": false`, points `main`
and `types` at a `dist/` emit shape, and compiles cleanly, but none of them
can actually be published to npm yet. Scoped packages default to `access:
restricted`, and nothing in the repo says which packages are public, which
are internal, how versions move, or how a release is cut.

We need those decisions to be explicit **at scaffolding time**, for three
reasons:

1. **Contributor clarity.** Every PR from `KRN-01` onward is going to touch
   published packages. Contributors need a one-sentence recipe ("include a
   changeset") before the first real kernel PR, not six months into Epic 1.
2. **Public surface clarity.** We have 18 publishable packages, a reference
   example, a monorepo root, a `contracts/` tree, and a `specs/` tree. All
   of them live side-by-side under one repo. Without an explicit decision,
   it is easy to either accidentally publish the example or accidentally
   exclude the wrong thing.
3. **Downstream trust.** npm provenance is GA in 2026 and is becoming a
   baseline expectation for new public packages. We can bake the intent in
   now at effectively zero cost; retrofitting it later means writing an ADR
   anyway and touching every package a second time.

This ADR captures the release-and-publishing stack that we commit to for
Generic AI. It does not wire CI (CTL-02 owns that) and it does not assign a
human release manager (CTL-03 owns that). It does fix enough structure that
CTL-02 and CTL-03 can land without having to re-litigate any of the
fundamental choices.

The planning pack's "Repo-Control And Compliance Decisions" section
explicitly says versioning and release expectations should live in the first
Linear plan and should be represented in both docs and ADRs. This ADR
satisfies that requirement.

## Decision

### Release tool: Changesets

Use [`@changesets/cli`](https://github.com/changesets/changesets) at version
`2.30.0`, pinned exact, as the single source of truth for versioning,
changelog generation, and publishing. The repo adds:

- `@changesets/cli@2.30.0` as a root devDependency, pinned exactly to match
  the FND-03 policy for every devDep.
- A `.changeset/` directory at the repo root, containing `config.json` and
  a Generic AI-specific `README.md`.
- Four root `package.json` scripts: `changeset`, `changeset:status`,
  `changeset:version`, and `changeset:publish`.

`changeset:version` runs `changeset version && npm install --package-lock-only`
so that the version bump keeps the lockfile in sync without forcing a full
`node_modules` reinstall. `changeset:publish` runs `npm run build && changeset
publish` so that CI has to ship a compiled `dist/` for every package before
the registry accepts a tarball. The `changeset:status` alias exists so
contributors and CI can peek at pending changesets without side effects.

### Versioning strategy: independent (semver per package)

Generic AI is plugin-first. Plugins are designed to move at their own cadence
and to be replaceable in situ. That is exactly the shape that changesets'
**independent** versioning (the default: `fixed: []` and `linked: []`) is
designed for. A fix in `plugin-storage-sqlite` should not bump
`plugin-mcp`'s version number; the SDK evolving should not drag every
plugin's major version forward.

We considered three alternative versioning strategies:

- **Fully fixed** (all packages always share one version). Rejected because
  it couples plugin release cadences and inflates version noise. It is the
  right call for tightly coupled clusters (the React ecosystem, for
  example), not for plugin-first frameworks.
- **Linked clusters** (for example, `@generic-ai/core` and `@generic-ai/sdk`
  always moving together). Rejected *for now*, because we do not yet have
  the evidence that the coupling is painful. We explicitly reserve the
  right to revisit with a successor ADR once Epic 1 lands and the kernel /
  SDK relationship has settled.
- **Ad-hoc manual bumping** (edit `package.json` by hand, no automation).
  Rejected because it scales poorly past three packages and loses changelog
  hygiene entirely.

Independent versioning gives us per-package semver discipline now without
locking us out of linking clusters later.

### Access and provenance on every public package

Every package under `packages/*` declares:

```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

`access: "public"` is mandatory for scoped packages. Without it, `npm publish
@generic-ai/core` would fail with a 402 because the default for scoped
packages is `restricted`. Setting it explicitly on every package is safer
than relying on the changesets `access: "public"` setting alone, because a
contributor who runs `npm publish` in one package directory (bypassing
changesets) still gets the right access mode.

`provenance: true` requests an npm provenance attestation on publish. It has
no local effect at all; it only takes effect when the publish runs inside a
supported CI environment with OIDC configured. If someone tries to
`npm publish` locally with this flag set, the publish fails with a clear
"not running in a trusted CI environment" error. That failure is desirable:
it prevents releases from being cut from laptops.

### Fixed vs private: the public / internal package split

The classification is explicit.

- **Public (18 packages):** every directory under `packages/*`. Each has
  `"private": false` plus the `publishConfig` block above. They publish to
  npm under the `@generic-ai/` scope.
- **Internal / never published:**
  - The root `@generic-ai/monorepo` is `"private": true`. It is the
    workspace container.
  - `examples/starter-hono/` carries a `package.json` with
    `"name": "@generic-ai/example-starter-hono"` and `"private": true`. We
    added this `package.json` as part of FND-04 so that npm workspaces and
    changesets both see the example as a known-private package. Without a
    `package.json`, the directory was invisible to both tools, which made
    "is this thing public or private?" an implicit answer rather than an
    explicit one.
  - The example is also listed in the `ignore` array of
    `.changeset/config.json` as a belt-and-braces measure. Changesets
    already skips packages with `"private": true`, and the `ignore`
    entry plus the `privatePackages: { version: false, tag: false }`
    config make the intent unmistakable.
  - `contracts/` and `specs/` are top-level directories, not npm
    workspaces, and are not in scope for publishing.

### Changelog policy

Changesets generates one `CHANGELOG.md` per package, grouped by version,
bump type (major / minor / patch), and human summary. That is the
authoritative changelog for each package. There is intentionally no
repo-wide `CHANGELOG.md`.

We follow the Keep-a-Changelog conventions as expressed by the
`@changesets/cli/changelog` generator: one section per version, entries
attributed back to the change summary the contributor wrote inside the
changeset.

### CI and release ownership: explicitly deferred

This ADR deliberately does **not**:

- wire a GitHub Actions workflow for changesets;
- add `.github/workflows/release.yml`;
- install the changesets GitHub Action;
- sign tags or commits;
- run `npm publish`;
- configure OIDC or trusted publishing on the npm side;
- create or rotate an `NPM_TOKEN`;
- define a human release manager or escalation path.

Those are owned by:

- **`CTL-02`** — CI wiring, branch protection, required checks, the
  `permissions: id-token: write` grant on the publish job, and the npm
  trusted-publisher binding for the `@generic-ai` scope.
- **`CTL-03`** — release manager role, hotfix / rollback policy, release
  escalation path.
- **`CTL-06`** — software-supply-chain and security controls, including
  anything around Sigstore policy and dependency-update automation.

Until `CTL-02` lands, releases are manual. The manual path is documented
in `RELEASING.md`. It is an explicit stopgap, not a target.

### Pre-release channels: documented intent, not yet used

`next`, `alpha`, and `beta` dist-tags are documented as the eventual
pre-release channels in `RELEASING.md`. They are not used during the
scaffolding epics. Every package stays pinned at `0.0.0` until Epic 1
(`KRN-*`) produces real contracts and the first `0.1.0` is cut.

## Consequences

### Positive

- Every published package declares both its access level and its provenance
  intent up front, which is the 2026 baseline for new public npm packages.
- Contributors get a one-line recipe (`npm run changeset`) for declaring
  version bumps, and changelog hygiene becomes automatic. No contributor
  edits a `CHANGELOG.md` or a `version` field by hand.
- The public / internal split is explicit and enforced in three layers:
  each package's own `private` field, each scoped package's `publishConfig`,
  and the changesets `ignore` list. A future contributor who adds a package
  under `packages/*` or `examples/*` has a clear template to copy.
- The `provenance: true` flag fails loudly the moment someone tries to
  publish from a laptop, which is exactly the safety property we want.
- `CTL-02` has a concrete pre-baked target: wire the changesets GitHub
  Action, grant `id-token: write`, and point it at `npm run
  changeset:publish`. No fundamental decisions remain.
- `CTL-03` can name a release manager without having to first decide what
  release even means here.
- Changesets composes cleanly with FND-03's toolchain: the build step is
  already `tsc -b`, which `changeset:publish` invokes via `npm run build`
  before publishing.
- The decision is reversible. Moving to `linked` clusters or changing the
  changelog format is a successor ADR plus a config edit, not a rescaffold.

### Negative or to-be-paid

- Every PR that ships a real user-visible change is expected to include a
  changeset file. For contributors who are new to changesets this is an
  extra step. `CONTRIBUTING.md` explains the recipe in a dedicated
  subsection so the friction is minimal.
- Independent versioning means consumers who "upgrade the framework" bump
  multiple packages at once. The starter preset softens that by owning the
  canonical composition; most consumers upgrade via the preset.
- `publishConfig.provenance: true` deliberately makes `npm publish` fail
  outside CI. If a contributor tries to publish ad-hoc, they will see a
  non-obvious error. `RELEASING.md` calls that out explicitly so the error
  is not a mystery.
- Changesets is the dominant 2026 choice but not universal. Nx-based
  monorepos use `nx release`, and some projects stay on semantic-release.
  We are betting that the changesets model (explicit intent declared in
  PRs) fits a plugin-first framework better than commit-message-derived
  automation. That bet is reversible but not free to reverse.
- The `@changesets/cli` install adds roughly 100 transitive packages to
  `devDependencies`. We accept that cost because the tool is well
  maintained and the transitive surface is limited to devDeps.
- Biome 2.4 does not format Markdown. Neither `RELEASING.md` nor this ADR
  is formatted by the quality gate; contributors who edit these files are
  on their own for wrapping and consistency. We explicitly decided **not**
  to change the toolchain for this, per the FND-04 constraint. A follow-up
  issue can layer a Markdown formatter (dprint, prettier) on top if we
  feel the pain.

### What is intentionally not in this ADR

- CI workflow files, branch protection, required checks: `CTL-02`.
- Release manager naming, hotfix policy, escalation path: `CTL-03`.
- Dependabot, CODEOWNERS, Sigstore policy, SBOM: `CTL-06`.
- Docs-as-code, generated API docs, changelog rendering in published docs:
  `CTL-04`.
- Real kernel / SDK / plugin source: Epic 1 and beyond.

## Alternatives Considered

### Release tool

- **`semantic-release`**. Derives version bumps from commit messages
  following the Conventional Commits spec. Rejected because:
  1. It ties version bumps to commit messages, which pushes version
     decisions down to individual commits rather than up to the PR.
     Changesets' model of "declare intent in a file" is easier to review
     and harder to get wrong.
  2. The monorepo plugin (`semantic-release-monorepo`) is a community
     effort with weak maintenance activity and less robust dependency
     propagation than changesets.
  3. It assumes a clean link from commit messages to version semantics.
     A plugin-first framework with 18 packages makes that link noisy.
- **`nx release`**. The integrated Nx release command. Rejected because
  Generic AI explicitly does not use Nx (ADR 0001 rejected Nx as
  over-tooling for the scaffold phase). Adopting `nx release` without
  Nx would mean pulling in a large tool just for the release flow.
- **`release-please`**. Google's alternative to semantic-release, based on
  conventional commits and release-PRs. Rejected for the same "commit
  messages as the source of truth" reason as semantic-release, plus its
  monorepo support is more focused on Google's own use cases than
  heterogeneous plugin ecosystems.
- **Lerna**. The historical JS monorepo tool. Rejected because its
  active-development story has been rocky since 2022 and it is no longer
  the default recommendation for new TypeScript monorepos.
- **Manual bumping**. Edit `package.json` files by hand. Rejected
  because it does not scale past a handful of packages, loses changelog
  hygiene, and places all the responsibility on the release manager.

### Versioning strategy

- **Fully fixed versioning.** Every package always shares one version.
  Rejected because it couples plugin release cadences and produces noisy
  version churn for consumers.
- **Linked clusters now (for example kernel + SDK).** Rejected *for now*;
  reserved as a future refinement if the cadence proves painful.
- **CalVer (date-based versioning) on top of independent semver.**
  Rejected because it confuses consumers trying to reason about semver
  compatibility. CalVer is legitimate for "continuously rolling"
  products; Generic AI is a framework with explicit API contracts.

### Provenance

- **Turn provenance off and add it later.** Rejected because retrofitting
  provenance means touching every package a second time and writing
  another ADR. Declaring the intent now is cheap.
- **Use a vendor signing tool instead of npm-native provenance.**
  Rejected because npm-native provenance is GA in 2026, integrates
  directly with `npm publish`, and does not require consumers to install
  verification tooling out-of-band.

### Changelog policy

- **Keep handwritten CHANGELOG.md files.** Rejected because handwritten
  changelogs drift. Changesets' generation is exactly good enough for
  our stage.
- **Conventional-commits-driven changelog (github-changelog-generator,
  git-cliff, etc.).** Rejected because it is redundant with the
  changeset summary text and re-introduces the commit-message coupling
  we wanted to avoid.
- **Repo-wide `CHANGELOG.md` at the root.** Rejected because
  per-package changelogs are more useful to consumers of individual
  plugins. A repo-wide changelog would either duplicate the
  per-package entries or lose detail.

## Research notes

Summary of the web research done before writing this ADR (full citation
trail lives in the NEI-307 Linear decision log):

- Changesets is consistently described as the default 2026 choice for
  TypeScript monorepo versioning when explicit intent and per-PR changeset
  files are preferred over commit-message derivation. It is used by Hono
  (via `honojs/middleware`), Radix UI, tRPC-adjacent projects, Shadcn,
  Vercel-published packages, and many framework repositories with a
  similar multi-package shape.
- `semantic-release` remains the alternative most teams consider; its
  monorepo support (`semantic-release-monorepo`) has weak maintenance
  activity in 2026 and is not the mainstream recommendation for new
  TypeScript framework monorepos. `release-please` is also active but
  carries similar trade-offs.
- `nx release` is a strong choice for teams that are already committed
  to Nx. Generic AI is not.
- Independent versioning is described across 2026 guidance as the right
  default for "plugin ecosystems, loosely coupled packages, and packages
  with different release cycles." Fixed versioning is the right default
  for tightly coupled package clusters. Generic AI is in the first
  category.
- npm provenance via OIDC reached GA in July 2025 and is now the
  baseline expectation for new public scoped packages. When publishing
  via trusted publishing from GitHub Actions, the `--provenance` flag is
  no longer strictly required because npm emits provenance by default,
  but `publishConfig.provenance: true` in `package.json` is still the
  explicit way to declare the intent and to fail loudly outside CI.
- Scoped npm packages default to `access: restricted`. Setting
  `publishConfig.access: "public"` is mandatory for any scoped package
  that wants to be publicly discoverable.
- Changesets supports the `"access": "public"` option at the tool level
  as well, but setting it on each package is safer because it survives
  tooling bypass (for example, a contributor running `npm publish` in
  one package directory by mistake).
- The keep-a-changelog format is still the dominant changelog format
  in 2026. Changesets' default changelog generator emits entries that
  are a minimal variant of it (version heading, bump type grouping,
  human summary), which is sufficient for our needs.
- The prerequisite for npm provenance from GitHub Actions is
  `permissions: { id-token: write }` on the publish job plus a trusted
  publisher binding on the npm registry side. CTL-02 will own the first
  piece; CTL-06 will own the security-hygiene framing of the second.
- Pinning `packageManager` in `package.json` plus a single source of
  truth for the release command (`npm run changeset:publish`) is the
  2026 mainstream way to keep releases reproducible between contributor
  laptops and CI.

No single source is treated as normative; this is the confluence of
multiple 2026 blog posts, framework repositories, tool documentation, and
npm / GitHub changelog entries sampled while writing this ADR.

## Cross-references

- Monorepo scaffold and package layout: `docs/decisions/0001-monorepo-scaffold.md`
- Base toolchain, quality gate, and devDep pinning policy: `docs/decisions/0002-base-toolchain.md`
- Release playbook and per-package classification: `RELEASING.md`
- Public package boundaries and roles: `docs/package-boundaries.md`
- Planning pack: `docs/planning/README.md`
