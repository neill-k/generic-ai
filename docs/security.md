# Security and Supply Chain

This document is the operational companion for `CTL-06`.

## Secret Handling

Secrets must not be committed. `.gitignore` blocks `.env` and `.env.*` while allowing `.env.example` for documented placeholders.

Do not add real provider keys, npm tokens, Docker registry tokens, or GitHub tokens to examples, docs, tests, or snapshots. Use named environment variables and document how to set them locally.

## Dependency Updates

Dependabot is configured in `.github/dependabot.yml` for:

- npm workspace dependencies,
- GitHub Actions versions.

Dependabot PRs should run the full quality gate before merge. Security updates can be grouped only when the grouped diff remains reviewable.

## Dependency Audit

`.github/workflows/security.yml` runs a scheduled and PR-time production `npm audit` with `--audit-level=moderate`. The job fails when moderate-or-higher production advisories are present. Keep it outside the required branch-protection set until the team explicitly decides dependency audit should block ordinary merges.

## Ownership Review

`.github/CODEOWNERS` routes all code-owner review requests. Branch protection should require Code Owner review on `main`.

## Runtime Security

Runtime security is tracked separately:

- `docs/runtime-governance.md` covers future policy and tool-permission surfaces.
- `docs/sandbox/security-model.md` covers the Docker-backed sandbox execution posture.
- `docs/sandbox/operator-guide.md` covers enabling the sandbox path.

## Deferred Controls

The following controls are intentionally planned but not fully landed by this baseline:

- SAST with uploaded SARIF,
- SBOM generation,
- npm trusted publishing workflow,
- release attestation verification,
- automated secret scanning beyond GitHub's platform controls.

Add these as separate issues when the repo is ready to make the checks required rather than advisory.
