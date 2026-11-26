# Security and Supply Chain

This document is the operational companion for `CTL-06`.

## Secret Handling

Secrets must not be committed. `.gitignore` blocks `.env` and `.env.*` while allowing `.env.example` for documented placeholders.

Do not add real provider keys, npm tokens, Docker registry tokens, or GitHub tokens to examples, docs, tests, or snapshots. Use named environment variables and document how to set them locally.

At runtime, agents get credentials through `@generic-ai/plugin-secrets` (ADR 0055): they write `{{secret:NAME}}` in a tool input, the value is filled in only if their role's `secrets` grant covers it, and every known secret value is replaced with `[REDACTED:NAME]` in tool results, events, traces and artifacts. Hosts set secrets as `GENERIC_AI_SECRET_<NAME>` environment variables, Docker secret files, or the encrypted store (`GENERIC_AI_SECRETS_KEY`). `DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, `GENERIC_AI_AUTH_TOKEN` and `GENERIC_AI_OWNER_SETUP_TOKEN` are host-only: redacted everywhere and never resolvable by an agent.

## Dependency Updates

Dependabot is configured in `.github/dependabot.yml` for:

- npm workspace dependencies,
- GitHub Actions versions.

Dependabot PRs should run the full quality gate before merge. Security updates can be grouped only when the grouped diff remains reviewable.

## Dependency Audit

`.github/workflows/security.yml` runs the production dependency audit on every pull request, on pushes to `main`, and weekly. It calls `npm run audit:prod` (`scripts/check-audit.mjs`), which runs `npm audit --omit=dev --omit=optional` and fails on any moderate-or-higher advisory that is not listed in `security/audit-allowlist.json`.

The allowlist is for advisories with no fixed release that cannot be removed yet. Each entry names the GHSA id, the package, why the risk is acceptable, and an expiry date. An expired entry fails the job, and an entry that no longer matches an advisory prints a warning so it can be deleted. Prefer upgrading, or an `overrides` entry in the root `package.json` that forces a patched transitive version, over adding to the allowlist.

The current entries all come from `@mariozechner/pi-coding-agent`, which is deprecated upstream and is being replaced by the native harness (roadmap R22). Remove them when pi is removed.

GitHub disables scheduled workflows after 60 days without repository activity. If the weekly run stops, re-enable it from the Actions tab (Security Baseline, then "Enable workflow").

Keep the job outside the required branch-protection set until the team explicitly decides dependency audit should block ordinary merges.

Note: GitHub disabled the Security Baseline workflow for inactivity (its weekly schedule), so it does not run on PRs until it is re-enabled under Actions.

## Secret Scanning

`.github/workflows/secret-scan.yml` runs gitleaks (pinned version, SHA-256 checked) over every commit of the branch on each PR to `main` and each push to `main`, and fails the build on any finding. Output is redacted. Before scanning it checks that gitleaks flags a fake GitHub token generated at run time, so a broken scanner cannot pass silently. A false positive is allowlisted in a `.gitleaks.toml` at the repo root, with a comment saying why; a real secret must be rotated, not allowlisted, because it stays in history.

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
- release attestation verification.

Add these as separate issues when the repo is ready to make the checks required rather than advisory.
