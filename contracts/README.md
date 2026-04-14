# contracts/

This directory holds frozen interface contracts that the Generic AI framework exposes to plugin authors and external consumers.

Contents belong here when a contract is intentionally stable and version-controlled as a source-of-truth artifact, not as ad-hoc TypeScript inside a package.

Expected initial contents, produced during Epic 1 and Epic 2 work (see `docs/planning/03-linear-issue-tree.md`):

- Kernel-facing plugin, lifecycle, registry, scope, and run-envelope contracts from `KRN-01`
- Config schema contracts from `CFG-01`
- Any other contracts promoted out of `@generic-ai/sdk` when they reach a freeze point

Current contract modules:

- `config/` - canonical `CFG-01` concern schemas and boundaries

Scope:

- This directory tracks contracts. It is not a place for implementation.
- Implementations live inside the relevant `packages/` entries.
- Breaking changes here follow the release conventions established in `FND-04`.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
