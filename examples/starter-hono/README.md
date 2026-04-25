# examples/starter-hono

Runnable Hono server example for the Generic AI starter preset.

What this example does now:

- boots from canonical `.generic-ai/` config via `createStarterHonoBootstrapFromYaml()`
- validates runtime environment at startup
- exposes `/starter/health`, `/starter/run`, and `/starter/run/stream`
- serves a production-built prompt playground at `/`
- uses a runtime adapter boundary in `@generic-ai/core`
- defaults to Pi's OpenAI Codex provider path for `gpt-5.2-codex`
- keeps `pi` available as an explicit compatibility adapter

The main server entrypoint is `examples/starter-hono/src/index.ts`. The playground source lives under `examples/starter-hono/ui/` and builds into `examples/starter-hono/dist/public/`, which the same Hono process serves at `/`.

The core package now also exposes a capability-to-`pi` runtime bridge (`createCapabilityPiAgentSession` / `runCapabilityPiAgentSession`) so the same starter capability stack can be projected into a real `AgentSession` when provider-facing runtime work is needed.

## Required environment

The server reads these values before it starts:

- `GENERIC_AI_PROVIDER_API_KEY` optional runtime key override. If unset, the
  server relies on Pi auth in the configured agent directory.
- `GENERIC_AI_MODEL` optional model override
- `GENERIC_AI_RUNTIME_ADAPTER` optional: `openai-codex` or `pi`
- `GENERIC_AI_WORKSPACE_ROOT` optional workspace root override
- `GENERIC_AI_HOST` or `HOST` optional host, default `127.0.0.1`
- `GENERIC_AI_PORT` or `PORT` optional port, default `3000`
- `GENERIC_AI_AUTH_TOKEN` optional bearer token for `/starter/run` and `/starter/run/stream`
- `GENERIC_AI_UNSAFE_EXPOSE` optional remote-exposure override; set to `1` only for deliberate unauthenticated exposure

Default model behavior:

- adapter `openai-codex`: uses Pi's `openai-codex` provider through
  `AuthStorage`, `ModelRegistry`, and `createAgentSession`
- adapter `pi`: uses `pi` with the OpenAI provider as an explicit compatibility path
- if `GENERIC_AI_MODEL` is unset, the example falls back to the primary agent model from `.generic-ai/agents/starter.yaml`

Security posture:

- local development binds to `127.0.0.1` by default
- non-loopback hosts such as `0.0.0.0`, LAN IPs, or public hostnames fail fast unless `GENERIC_AI_AUTH_TOKEN` is configured or `GENERIC_AI_UNSAFE_EXPOSE=1` is set
- when `GENERIC_AI_AUTH_TOKEN` is set, call run endpoints with `Authorization: Bearer <token>` or `x-generic-ai-token: <token>`
- unauthenticated health output is intentionally minimal and does not expose workspace paths or full bootstrap internals
- `GENERIC_AI_UNSAFE_EXPOSE=1` leaves command/file/MCP-capable runtime endpoints reachable without example-level auth; use it only in isolated, trusted environments

## Fresh clone path

Use Node 24 LTS for the whole workspace.

```bash
git clone <repo-url> generic-ai
cd generic-ai
nvm use
corepack enable
npm install
npm run -w @generic-ai/example-starter-hono build
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono start
```

PowerShell:

```powershell
$env:GENERIC_AI_PROVIDER_API_KEY = "<provider-key>"
npm run -w @generic-ai/example-starter-hono start
```

Open `http://127.0.0.1:3000/` for the playground UI. It includes:

- a prompt input seeded for a real single-file Three.js game generation workflow
- sync and streaming run modes
- optional bearer-token entry for protected remote runs
- a sandboxed HTML preview, raw HTML view, downloadable artifact, and run-event log

Remote exposure with a token:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
export GENERIC_AI_HOST="0.0.0.0"
export GENERIC_AI_AUTH_TOKEN="<long-random-token>"
npm run -w @generic-ai/example-starter-hono start
```

```bash
curl -X POST http://<server-host>:3000/starter/run \
  -H "authorization: Bearer <long-random-token>" \
  -H "content-type: application/json" \
  -d '{"input":"Explain what the Generic AI starter stack is."}'
```

Deliberate unauthenticated remote exposure:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
export GENERIC_AI_HOST="0.0.0.0"
export GENERIC_AI_UNSAFE_EXPOSE=1
npm run -w @generic-ai/example-starter-hono start
```

For local iteration without a build:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono dev
```

For frontend iteration, run the API server and Vite UI in two terminals:

Terminal 1:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
npm run -w @generic-ai/example-starter-hono dev
```

Terminal 2:

```bash
npm run -w @generic-ai/example-starter-hono dev:ui
```

The Vite UI runs on `http://127.0.0.1:3001/` and proxies `/starter/*` to the Hono server on port `3000`.

To exercise the sandbox-aware preset wiring, set the starter bootstrap env vars before launch:

```bash
export GENERIC_AI_SANDBOX=docker
export GENERIC_AI_SANDBOX_FALLBACK=fail
```

On Windows PowerShell:

```powershell
$env:GENERIC_AI_SANDBOX = "docker"
$env:GENERIC_AI_SANDBOX_FALLBACK = "fail"
```

When `GENERIC_AI_SANDBOX` is omitted, development defaults to unrestricted terminal mode and production defaults to the sandbox terminal slot. If Docker is unavailable, bootstrap warns and falls back unless `GENERIC_AI_SANDBOX_FALLBACK=fail` is set.

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
## Verification

```bash
npm run check:node
npm run typecheck
npm run lint
npm run test
npm run -w @generic-ai/example-starter-hono build
```

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/planning/03-linear-issue-tree.md`
- `docs/package-boundaries.md`
