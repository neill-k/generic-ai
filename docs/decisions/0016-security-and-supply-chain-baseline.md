# 0016 - Security and supply-chain baseline

- Status: accepted
- Date: 2026-04-24
- Linear: `NEI-382` (`CTL-06`)
- Supersedes: none
- Related:
  - `SECURITY.md`
  - `docs/security.md`
  - `.github/CODEOWNERS`
  - `.github/dependabot.yml`

## Context

The framework is becoming runnable enough that repository-level security expectations need to be visible in source control. Before this baseline, the repo had secret ignores but no security policy, dependency-update automation, code-owner routing, or supply-chain documentation on `main`.

## Decision

Add the first source-controlled security baseline:

- `SECURITY.md` for vulnerability reporting and supported-version posture.
- `.github/CODEOWNERS` for ownership-based review routing.
- `.github/dependabot.yml` for npm and GitHub Actions updates.
- `.github/workflows/security.yml` for scheduled and PR-time dependency audit visibility.
- `docs/security.md` for secret handling, dependency update, audit, ownership-review, and deferred control expectations.

The audit job is advisory because existing Dependabot PRs are already open for current advisories. It should become required once those updates land.

## Consequences

Security review has a default path instead of tribal knowledge. Dependency drift is now surfaced by Dependabot, and the repo can turn on Code Owner review in branch protection.

The baseline deliberately stops short of SAST, SBOM generation, npm trusted publishing, and SARIF upload. Those are separate follow-up controls that need tighter tool choices and clean baseline results.

## Alternatives Considered

- Require `npm audit` immediately. Rejected because pre-existing advisories would block unrelated repo-control work.
- Add a broad SAST workflow now. Rejected because the repo needs a tool choice and triage policy before making noisy scans part of the required gate.
- Keep security policy only in GitHub settings. Rejected because agents and contributors need repo-local instructions.
