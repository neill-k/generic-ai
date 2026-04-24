# 0015 - CI and branch-control baseline

- Status: accepted
- Date: 2026-04-24
- Linear: `NEI-382` (`CTL-02`)
- Supersedes: none
- Related:
  - `docs/planning/03-linear-issue-tree.md`
  - `docs/planning/04-agent-ready-mapping.md`
  - `docs/ci-and-branch-control.md`

## Context

The repo has a documented four-command quality gate, but `main` only had the live-provider smoke workflow. That left pull requests dependent on local discipline and made branch protection impossible to configure around stable check names.

## Decision

Add a PR-time GitHub Actions workflow named `Quality Gate` with four required jobs:

- `typecheck`
- `lint`
- `test`
- `build`

Each job runs on Node 24, installs with `npm ci`, and runs the same npm command contributors run locally. The workflow uses read-only repository permissions.

Add a separate `Docs as Code` workflow for generated documentation checks so docs drift can be required independently of compile/test failures.

Branch protection for `main` should require PR review, Code Owner review, up-to-date branches, and the five checks listed in `docs/ci-and-branch-control.md`.

## Consequences

PR health now has stable check names. Contributors can reproduce failures locally with the same commands. The jobs intentionally duplicate install work so each required check is independently visible in GitHub branch protection.

The security audit workflow is advisory until the dependency backlog is green. Making it required too early would block unrelated PRs on pre-existing advisories.

## Alternatives Considered

- One combined job. Rejected because branch protection and PR UI become less precise.
- A matrix job. Rejected because matrix check names are harder to document and require in branch protection.
- `pull_request_target`. Rejected for untrusted PR code because it grants broader token behavior than this repo needs.
