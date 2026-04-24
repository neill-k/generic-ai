# AGENTS.md

## Working Agreement

Work really hard.

This repository is the Generic AI framework monorepo. Treat the planning pack as the source of truth before changing package boundaries or public contracts:

- `docs/planning/README.md`
- `docs/planning/01-scope-and-decisions.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/planning/04-agent-ready-mapping.md`

Use `docs/package-boundaries.md` before moving code across packages. Plugins depend on `@generic-ai/sdk`, not `@generic-ai/core`; presets compose core and plugins.

## Verification

Run the relevant targeted checks while developing, then run the full gate before a PR:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run docs:check
```

The repo targets Node 24 and npm 11. For full-workspace verification, use the root `npm run typecheck`, which runs `tsc -b --pretty` (emit + cleanup) for this project-reference layout. Individual package-level `typecheck` scripts may still use `--noEmit` for faster local iteration, but do not replace the root workspace check with `tsc -b --noEmit`.

## Documentation

When a change alters public behavior, package ownership, configuration, or operational expectations, update docs in the same PR. ADRs live under `docs/decisions/` and should be added for cross-package decisions or explicit Linear decision-log requirements.
