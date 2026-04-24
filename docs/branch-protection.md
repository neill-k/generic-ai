# Branch Protection

This repository uses the `baseline-quality-gate` GitHub Actions workflow as the always-on merge gate for `main`.

## Required Checks

Configure the `main` branch protection rule to require these status checks before merge:

- `baseline-typecheck`
- `baseline-lint`
- `baseline-test`
- `baseline-build`

Those names are intentionally unique across workflows so GitHub can resolve the required checks without ambiguity. The live provider smoke workflow is not part of the required baseline gate because it depends on trusted secrets and remains manually dispatched.

## Rule Settings

The `main` rule should enforce:

- require a pull request before merging
- require status checks before merging
- require branches to be up to date before merging
- require conversation resolution before merging
- do not allow bypassing the above settings for the normal contributor flow
- disallow force pushes and branch deletion

Do not add path filters, actor filters, or conditional no-op branches to the baseline workflow. GitHub treats some skipped jobs as successful, while skipped workflows can leave required checks pending, so the four baseline jobs must run for every pull request that targets `main`.

## Verification

After changing the workflow or branch rule:

1. Open a pull request targeting `main`.
2. Confirm all four baseline checks start automatically.
3. Confirm a failing baseline check blocks merge.
4. Confirm the manual `live-provider-smoke` workflow is still opt-in and is not required for ordinary pull requests.

Reference docs:

- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub required status check troubleshooting](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks)
- [GitHub status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)
