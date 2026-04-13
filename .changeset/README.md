# Changesets

This folder holds pending changesets for the Generic AI framework monorepo. Each
changeset is a Markdown file describing a version bump (major, minor, or patch)
for one or more packages under `packages/*`, along with a short human-readable
summary.

Changesets were chosen for this repo in
[`docs/decisions/0003-release-and-publishing.md`](../docs/decisions/0003-release-and-publishing.md).
The full release playbook lives in [`RELEASING.md`](../RELEASING.md).

## TL;DR for contributors

Any pull request that touches a publishable package under `packages/*` should
include a changeset. The one-line recipe:

```bash
npm run changeset
```

Pick the affected packages, choose a bump type, and write a one-sentence
summary. Commit the generated file in `.changeset/` alongside your change.

Changesets apply only to the 18 publishable packages under `packages/*`.
The example under `examples/starter-hono/` is intentionally excluded via the
`ignore` list in `.changeset/config.json` and is marked `"private": true` in
its own `package.json`, so changesets will never version or publish it.

## Useful upstream docs

- Changesets intro: [`intro-to-using-changesets`](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
- Config options: [`config-file-options`](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md)
- Common questions: [`common-questions`](https://github.com/changesets/changesets/blob/main/docs/common-questions.md)
