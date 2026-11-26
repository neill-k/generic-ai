# examples/starter-hono

Runnable Hono server example for the Generic AI starter preset.

What this example does now:

- boots from canonical `.generic-ai/` config via `createStarterHonoBootstrapFromYaml()`
- validates runtime environment at startup
- exposes `/starter/health`, `/starter/run`, and `/starter/run/stream`
- serves a production-built prompt playground at `/`
- uses a runtime adapter boundary in `@generic-ai/core`
- defaults to Pi's OpenAI Codex provider path for `gpt-5.5`
- keeps `pi` available as an explicit compatibility adapter
- runs agents in the default stop-tool loop: the model must call
  `stop_and_respond` to end the run and return the final response

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
- `GENERIC_AI_PUBLIC_URL` optional public origin, for example `https://my-app.up.railway.app`. It turns on owner auth and fixes the passkey relying party. On Railway, `RAILWAY_PUBLIC_DOMAIN` is used when this is unset.
- `GENERIC_AI_OWNER_SETUP_TOKEN` optional one-time secret (16+ characters) for registering the first owner passkey. If owner auth is on and no passkey exists, the server prints a fresh one at startup instead.
- `DATABASE_URL` optional Postgres connection string. When set (and `GENERIC_AI_AUTH_DB` is not), owner auth records live in Postgres through `@generic-ai/plugin-storage-postgres`, so a Railway deploy with the Postgres plugin needs no volume for auth.
- `GENERIC_AI_AUTH_DB` optional SQLite file for owner auth records, default `~/.generic-ai/auth.sqlite`. It must be outside the agent workspace. It takes precedence over `DATABASE_URL`.
- `GENERIC_AI_TRUST_PROXY` optional; set to `1` behind a reverse proxy so sign-in rate limiting keys on the client address from `X-Forwarded-For`. It is on automatically when `RAILWAY_PUBLIC_DOMAIN` is set.
- `GENERIC_AI_OWNER_AUTH` optional; set to `1` to turn owner auth on locally without the variables above
- `GENERIC_AI_AUTH_TOKEN` optional break-glass owner bearer token (16+ characters) for every protected route
- `GENERIC_AI_UNSAFE_EXPOSE` optional remote-exposure override; set to `1` only for deliberate unauthenticated exposure

Default model behavior:

- adapter `openai-codex`: uses Pi's `openai-codex` provider through
  `AuthStorage`, `ModelRegistry`, and `createAgentSession`
- adapter `pi`: uses `pi` with the OpenAI provider as an explicit compatibility path
- if `GENERIC_AI_MODEL` is unset, the example falls back to the primary agent model from `.generic-ai/agents/starter.yaml`
- agent and harness configs default to `execution.turnMode: stop-tool-loop`;
  set `execution.turnMode: single-turn` only for deliberately one-turn demos or
  compatibility tests
- omit `execution.maxTurns` for the default unbounded stop-tool loop, or set a
  positive integer only when a demo needs a finite safety cap

Security posture:

- local development binds to `127.0.0.1` by default
- non-loopback hosts such as `0.0.0.0`, LAN IPs, or public hostnames fail fast unless owner auth is configured or `GENERIC_AI_UNSAFE_EXPOSE=1` is set
- with owner auth on, the console redirects to `/auth/login`; the owner signs in with a passkey, and the same page creates, lists, and revokes API tokens
- scripts call run endpoints with `Authorization: Bearer <api token>` (or the break-glass `GENERIC_AI_AUTH_TOKEN`); `x-generic-ai-token: <token>` is still accepted
- every run envelope and run event records who started it as `actor` (owner, credential source, and token id), never the credential itself; console chat runs record it on the user message, the `run.started` event, and the harness run events
- failed sign-in and setup attempts are limited to 5 per client and 50 overall per 15 minutes, answered with `429` and `Retry-After`
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
- an immediate conversation trail with a compact running indicator while the preview updates
- a live activity rail for streamed runtime/session events such as turns, messages, and tool calls
- optional bearer-token entry for protected remote runs
- a sandboxed HTML preview, raw HTML view, downloadable artifact, and run-event log

Remote exposure with owner login (passkey) and API tokens:

```bash
export GENERIC_AI_PROVIDER_API_KEY="<provider-key>"
export GENERIC_AI_HOST="0.0.0.0"
export GENERIC_AI_PUBLIC_URL="https://<your-domain>"
export DATABASE_URL="postgres://<user>:<password>@<host>:5432/<db>"  # or GENERIC_AI_AUTH_DB=/data/auth.sqlite
npm run -w @generic-ai/example-starter-hono start
# The log prints a one-time setup token. Open https://<your-domain>/auth/login,
# paste it, and create the owner passkey. Then create API tokens on that page.
```

Passkeys need a secure context: use https for any host other than `localhost`.
Register a second passkey (or keep `GENERIC_AI_AUTH_TOKEN` set) so losing one
device does not lock you out.

```bash
curl -X POST http://<server-host>:3000/starter/run \
  -H "authorization: Bearer <api-token>" \
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

For local iteration, the dev script builds the server references, keeps TypeScript
watching, and runs the built server with Node watch mode:

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

The stream endpoint emits canonical run lifecycle events, forwards runtime activity events such as `pi.tool_execution_start` and `pi.tool_execution_end` when the provider session reports them, and finishes with a terminal `run.envelope` event that contains the real provider response payload.

## Live provider smoke test

`RT-05` adds an opt-in smoke test that drives the real provider path with a deterministic write/read task. The default provider target is OpenAI Codex via pi auth (`openai-codex` + `gpt-5.5`), but the harness stays provider-aware so local runs can override the provider/model without rewriting the test contract.

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
- Every live run incurs real provider cost. It runs only by hand: the test lives in `src/live-smoke.live.test.ts`, which `npm test` and CI skip, and there is no workflow for it.

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
