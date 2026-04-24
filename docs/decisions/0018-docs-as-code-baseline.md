# 0018 - Docs-as-code baseline

- Status: accepted
- Date: 2026-04-24
- Linear: `NEI-382` (`CTL-04`)
- Supersedes: none
- Related:
  - `docs/docs-as-code.md`
  - `scripts/generate-docs.mjs`
  - `docs/generated/package-index.md`

## Context

The root `npm run docs` script was a placeholder even though the planning pack tracks docs-as-code as a phase-one repo-control surface. The repo does not yet need a heavy API extractor, but it does need one deterministic generated documentation path that CI can enforce.

## Decision

Replace the placeholder with:

- `npm run docs` to regenerate generated docs,
- `npm run docs:check` to verify generated docs are current,
- `scripts/generate-docs.mjs` as the deterministic generator,
- `docs/generated/package-index.md` as the first generated artifact.

The generated package index is sourced from workspace `package.json` files and README presence. Type-level API docs remain deferred until the public API surface stabilizes.

## Consequences

Docs-as-code has a real command and a real CI check without adding another dependency. Package metadata drift is visible in review.

The generated output is intentionally modest. Future TypeDoc or API Extractor adoption should extend this path rather than replace the command names.

## Alternatives Considered

- Add TypeDoc immediately. Rejected because the public API is still moving and TypeDoc would add tool ceremony before generated API pages are useful.
- Keep `npm run docs` as a placeholder. Rejected because CI cannot enforce a placeholder.
- Generate no committed output. Rejected because reviewers need a concrete artifact to see drift and validate the command.
