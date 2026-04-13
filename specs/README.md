# specs/

This directory holds specifications the Generic AI docs-as-code and contract workflows consume.

Specs belong here when they describe framework behavior precisely enough to be verified or generated from. This is distinct from `docs/planning/`, which captures scope and architecture, and from `contracts/`, which captures frozen interface shapes.

Expected initial uses (see `docs/planning/03-linear-issue-tree.md`):

- Inputs for the generated-docs path set up by `CTL-04`
- Inputs for the contract-testing approach set up by `CTL-05`
- Specs referenced by `CFG-01` config schemas and `KRN-01` kernel contracts where a human-readable specification is useful alongside machine-readable artifacts

Rules:

- Specs here are source-of-truth for the behaviors they describe.
- When a spec changes, affected contracts, packages, and tests should be updated in the same change.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
