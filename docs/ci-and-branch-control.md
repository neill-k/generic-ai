# CI and Branch Control

This document is the operational companion for `CTL-02`.

## Required PR Checks

Every pull request to `main` should pass:

- `baseline-quality-gate / baseline-typecheck`
- `baseline-quality-gate / baseline-lint`
- `baseline-quality-gate / baseline-test`
- `baseline-quality-gate / baseline-build`
- `Docs as Code / docs-check`

The four baseline quality-gate jobs match the first four local commands in `CONTRIBUTING.md`:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

`baseline-test` runs against a Postgres service, and `baseline-build` also replays every company template's goal evals offline.

`Docs as Code / docs-check` runs `npm run docs:check` and verifies generated documentation is current.

## Keeping Actions minutes down

Each check runs once per push. The rules that keep it that way:

- Every workflow cancels its run for a PR when a newer commit is pushed.
- `Quality Gate / e2e` and `generic-corp-image / image-smoke` are the slow jobs (a browser, a Docker build). They run only when `apps/generic-corp/**`, `packages/**`, the lockfile or their own workflow changes, on PRs and on `main`.
- `Security Baseline / dependency-audit` runs on PRs and weekly, not again on every merge to `main`.
- No workflow calls a real model. Live runs are manual and local: `npm run reliability -w @generic-ai/app-generic-corp` and `npm run test:live -- <file>`. See `CONTRIBUTING.md`.

Do not add a workflow that repeats the baseline jobs.

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

The `Security Baseline / dependency-audit` job blocks its own workflow on moderate-or-higher production dependency advisories. Keep branch protection focused on the five checks above unless the team decides dependency audit should also become a required merge check.

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
