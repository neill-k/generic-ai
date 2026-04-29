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

Runtime and harness work that touches `pi` must keep the adapter boundary explicit. Re-export extension and embedding primitives only through `@generic-ai/sdk/pi`, keep kernel translation code in `packages/core/src/runtime`, and update `contracts/pi-boundary/README.md`, `docs/generic-ai-and-pi.md`, or `docs/harness-dsl.md` when that contract changes.

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

When editing `examples/starter-hono/ui/`, rebuild the Vite assets with `npm run -w @generic-ai/example-starter-hono build:ui` before browser verification. The root `npm run build` runs TypeScript project references and does not refresh the served UI bundle.

When changing harness DSL, runtime adapters, or provider-facing starter behavior, run targeted harness and starter tests during development:

```bash
npm test -- packages/core/src/harness/agent-harness.test.ts packages/sdk/test/harness/mock-runtime.test.ts examples/starter-hono/src/index.test.ts examples/starter-hono/src/live-smoke.test.ts
```

Provider-backed live smoke is opt-in and can incur real provider cost; run it only with trusted credentials or Pi auth configured:

```powershell
$env:GENERIC_AI_ENABLE_LIVE_SMOKE = "1"; npm run -w @generic-ai/example-starter-hono test:live
```

For publish or package-surface changes, verify the actual npm payload with `npm pack --workspace <package-name> --dry-run --json`; for example, use `npm pack --workspace @generic-ai/plugin-web-ui --dry-run --json` when touching the web UI plugin publish surface.

## Documentation

When a change alters public behavior, package ownership, configuration, or operational expectations, update docs in the same PR. ADRs live under `docs/decisions/` and should be added for cross-package decisions or explicit Linear decision-log requirements.

For docs-only changes, `npm run docs:check` is the authoritative generated-docs gate. If it reports stale generated docs, run `npm run docs` and review the generated diff; Markdown content still needs manual readback because Biome does not lint Markdown in this repo.
