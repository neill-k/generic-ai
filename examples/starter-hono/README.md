# examples/starter-hono

Reference example for the Generic AI starter preset.

What this example shows:

- `createGenericAI()` with no arguments resolves the starter preset by default
- callers can still pass `createStarterHonoPreset()` explicitly when they want the composition to be visible in code
- the example keeps the bootstrap layer and the preset package separate, which matches the repo boundary model

The main source entrypoint is `examples/starter-hono/src/index.ts`. It is intentionally small for now so later runtime work can swap in the real kernel wiring without changing the example shape.

## Fresh clone run path

Use Node 24 LTS for the whole workspace. The root `.nvmrc`, root `package.json#engines.node`, this example package's `engines.node`, `.npmrc` `engine-strict=true`, and the `check:node` script all enforce the same floor so installs and CI fail before doing real work on an unsupported runtime.

From a fresh clone:

```bash
git clone <repo-url> generic-ai
cd generic-ai
nvm use
corepack enable
npm install
npm run build
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono start -- "the Generic AI starter stack"
```

On Windows PowerShell, set the key with:

```powershell
$env:GENERIC_AI_PROVIDER_API_KEY = "<provider-key>"
```

The current starter harness runs the local plugin composition and validates that the provider key is present. The later RT-04 runtime work will use the same run path for live provider execution.

## Live provider smoke test

`RT-05` adds an opt-in smoke test that drives the real provider path with a deterministic write/read task. The default provider target is OpenAI Codex via pi auth (`openai-codex` + `gpt-5.4`), but the harness stays provider-aware so trusted CI or local runs can override the provider/model without rewriting the test contract.

Local setup:

```bash
export GENERIC_AI_ENABLE_LIVE_SMOKE=1
npm run -w @generic-ai/example-starter-hono test:live
```

For OpenAI Codex, log in first with `pi` so `~/.pi/agent/auth.json` contains an `openai-codex` entry. To point the test at a different auth directory, set `GENERIC_AI_LIVE_AGENT_DIR=/path/to/pi-agent-dir`.

For API-key providers, set `GENERIC_AI_LIVE_PROVIDER` / `GENERIC_AI_LIVE_MODEL` as needed and provide credentials either through the provider's normal environment variable (for example `OPENAI_API_KEY`) or `GENERIC_AI_LIVE_PROVIDER_API_KEY`.

Safety and teardown notes:

- The live smoke run is opt-in and returns a skipped result unless `GENERIC_AI_ENABLE_LIVE_SMOKE=1` is set.
- The prompt is constrained to the shipped file tools only. It writes `workspace/shared/live-smoke.txt`, reads it back, and finishes with `LIVE_SMOKE_DONE`.
- The test uses a disposable temp workspace root and removes it after the run.
- Every live run incurs real provider cost. Keep it for trusted local runs and trusted CI only.

Trusted CI can inject an auth directory by writing a secret JSON payload to `${RUNNER_TEMP}/pi-agent/auth.json` and exporting `GENERIC_AI_LIVE_AGENT_DIR=${RUNNER_TEMP}/pi-agent` before calling `npm run -w @generic-ai/example-starter-hono test:live`.

Useful verification commands:

```bash
npm run check:node
npm run typecheck
npm run lint
npm run test
npm run build
```

## Starter preset extension points

When the example needs customization, use programmatic contract extension points:

- slot overrides (for replacing defaults like storage/transport)
- addon plugins before/after a slot anchor

There is no separate user-facing `preset.yaml` file in v1.

## Planning baseline

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
