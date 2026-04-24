# Docs as Code

This document covers `CTL-04`.

## Generated Package Index

`npm run docs` regenerates `docs/generated/package-index.md` from the workspace package manifests. The generated file is intentionally small and deterministic:

- package name,
- package path,
- publish status,
- package description,
- README link when present.

Use `npm run docs:check` in CI to verify the committed index matches the package manifests.

## Ownership

Generated documentation belongs with the source data it describes. Package metadata comes from each workspace `package.json`; package prose remains in the package `README.md`.

Do not hand-edit files under `docs/generated/`. Update the source package metadata, then rerun:

```bash
npm run docs
```

## Future API Docs

The generated package index is the first docs-as-code surface. Type-level API extraction is still deferred until the public API stabilizes enough to justify a dedicated tool such as TypeDoc or API Extractor.

When that lands, it should extend the same pattern:

- one deterministic generation command,
- one check command for CI,
- committed generated output only when it is useful for review,
- clear ownership between source comments, package READMEs, and generated API pages.
