# Ownership and Task Discovery

This document is the operational companion for `CTL-03`.

## Code Ownership

GitHub review routing is defined in `.github/CODEOWNERS`. The current repo is single-maintainer, so all paths route to `@neill-k`; the path groups still matter because they make later team ownership changes obvious.

Ownership groups:

- framework kernel and SDK: `packages/core/`, `packages/sdk/`
- preset and example: `packages/preset-starter-hono/`, `examples/`
- plugins: `packages/plugin-*/`
- planning and documentation: `docs/`, `contracts/`, `specs/`
- repo control plane: `.github/`, `scripts/`

## Pull Requests

Every PR should include:

- a short summary,
- the verification commands run,
- related Linear issues or ADRs,
- follow-up work that intentionally remains out of scope.

The PR template in `.github/pull_request_template.md` captures this baseline.

## Issues

Use GitHub issue forms for outside-in bugs or feature requests. Linear remains the implementation tracker for planned repo work, but GitHub issues give external contributors a structured intake path.

Issue forms live under `.github/ISSUE_TEMPLATE/`:

- `bug.yml` for reproducible defects,
- `feature.yml` for new framework capability proposals,
- `config.yml` to direct broad roadmap questions back to the planning pack.

## Task Discovery

Before starting implementation work:

1. Check the relevant Linear issue and parent issue.
2. Read the planning pack if the work changes scope, architecture, or sequencing.
3. Read `docs/package-boundaries.md` before touching package dependencies or public exports.
4. Search existing PRs for overlapping branches.
5. Record the chosen approach in Linear when the issue asks for a decision log.
