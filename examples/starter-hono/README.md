# examples/starter-hono

Runnable Hono server example for the Generic AI starter preset.

What this example does now:

- boots from canonical `.generic-ai/` config via `createStarterHonoBootstrapFromYaml()`
- validates provider/runtime environment at startup
- exposes `/starter/health`, `/starter/run`, and `/starter/run/stream`
- uses a runtime adapter boundary in `@generic-ai/core`
- defaults to the official OpenAI Responses client for `gpt-5.2-codex`
- keeps `pi` available as an explicit compatibility adapter

## Required environment

The server validates these values before it starts:

- `GENERIC_AI_PROVIDER_API_KEY` required for both adapters
- `GENERIC_AI_MODEL` optional model override
- `GENERIC_AI_RUNTIME_ADAPTER` optional: `openai-codex` or `pi`
- `GENERIC_AI_WORKSPACE_ROOT` optional workspace root override
- `GENERIC_AI_HOST` or `HOST` optional host, default `127.0.0.1`
- `GENERIC_AI_PORT` or `PORT` optional port, default `3000`

Default model behavior:

- adapter `openai-codex`: uses the official OpenAI Responses API
- adapter `pi`: uses `pi` with the OpenAI provider as an explicit compatibility path
- if `GENERIC_AI_MODEL` is unset, the example falls back to the primary agent model from `.generic-ai/agents/starter.yaml`

## Fresh clone path

Use Node 24 LTS for the whole workspace.

```bash
git clone <repo-url> generic-ai
cd generic-ai
nvm use
corepack enable
npm install
npm run build
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono start
```

PowerShell:

```powershell
$env:GENERIC_AI_PROVIDER_API_KEY = "<provider-key>"
npm run -w @generic-ai/example-starter-hono start
```

For local iteration without a build:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono dev
```

## End-to-end requests

Health:

```bash
curl http://127.0.0.1:3000/starter/health
```

Sync run:

```bash
curl -X POST http://127.0.0.1:3000/starter/run \
  -H "content-type: application/json" \
  -d '{"input":"Explain what the Generic AI starter stack is."}'
```

Stream run:

```bash
curl -N -X POST http://127.0.0.1:3000/starter/run/stream \
  -H "content-type: application/json" \
  -d '{"input":"Summarize the starter stack in three bullets."}'
```

The stream endpoint emits canonical run lifecycle events followed by a terminal `run.envelope` event that contains the real provider response payload.

## Verification

```bash
npm run check:node
npm run typecheck
npm run lint
npm run test
npm run build
```

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
