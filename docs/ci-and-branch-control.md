# CI and Branch Control

This document is the operational companion for `CTL-02`.

## Required PR Checks

Every pull request to `main` should pass:

- `Quality Gate / typecheck`
- `Quality Gate / lint`
- `Quality Gate / test`
- `Quality Gate / build`
- `Docs as Code / docs-check`

The four quality-gate jobs intentionally match the local commands in `CONTRIBUTING.md`:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

`Docs as Code / docs-check` runs `npm run docs:check` and verifies generated documentation is current.

## Branch Protection

Configure the `main` branch protection rule in GitHub with:

- require a pull request before merging,
- require approvals,
- require review from Code Owners,
- require status checks to pass before merging,
- require branches to be up to date before merging,
- require the five checks listed above,
- block force pushes,
- block deletions.

The `Security Baseline / dependency-audit` job is intentionally advisory for now because existing advisories are being handled by Dependabot PRs. Make it required once the dependency backlog is green.

## Workflow Permissions

Workflows default to `contents: read`. Jobs should add write permissions only when the job has a concrete write operation, such as publishing, creating a release, or uploading a security artifact.

Do not use `pull_request_target` for untrusted code paths unless the workflow never checks out or executes code from the pull request.

## Local Parity

The CI jobs use Node 24 and `npm ci`, matching the root `packageManager` and `engines.node` policy. A clean local reproduction should be:

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run docs:check
```
