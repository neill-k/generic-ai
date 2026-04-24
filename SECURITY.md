# Security Policy

## Supported Versions

Generic AI is pre-1.0. Security fixes target the default branch first. Published package support will be formalized when the first public release train is cut.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Contact the repository owner directly with:

- affected package or workflow,
- minimal reproduction,
- impact assessment,
- known mitigations,
- whether exploitation requires local, CI, or deployed access.

The maintainer should acknowledge the report, decide whether a private advisory is needed, and track the remediation in Linear or GitHub with public details withheld until the fix is available.

## Baseline Controls

The repo carries:

- CODEOWNERS for ownership-based review routing,
- Dependabot version updates for npm and GitHub Actions,
- PR-time quality gates for typecheck, lint, test, and build,
- a scheduled dependency audit workflow,
- documented secret-handling and supply-chain expectations in `docs/security.md`.

Runtime sandboxing and tool-permission hardening are documented separately under `docs/sandbox/` and `docs/runtime-governance.md`.
