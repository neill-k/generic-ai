# 0062 Generic Corp deploy packaging: one image, Railway in production, Compose locally

## Context

ADR 0046 records D5: Generic Corp runs on Railway in production, with Docker
for local testing, and D4: one owner per deployment. The roadmap item R17
asks for the deploy itself; this record covers the packaging that has to
exist in the repository first. Nothing was containerised before this change.

The app server (`apps/generic-corp/dist/run.js`) already reads its
configuration from the environment, serves `/health` and `/ready`, uses
Postgres through `DATABASE_URL`, and keeps agent homes and workspaces under
`GENERIC_CORP_DATA_DIR`. Its agents get file and shell tools, the native grep
and find tools shell out to `rg` and `fd`, and the browser connector launches
the pinned `@playwright/mcp` package, which drives Google Chrome.

Railway runs one container per service. It does not let a container start
other containers, and it mounts volumes owned by root.

## Decision

- **One image for every environment.** `apps/generic-corp/Dockerfile` builds
  from the repository root in two stages: compile the app and the workspace
  packages it uses, then prune dev dependencies into a `node:24-bookworm-slim`
  runtime with bash, git, ripgrep, fd, tini and, on amd64, Google Chrome with
  the Playwright MCP package already in the `node` user's npx cache.
- **Non-root at runtime.** The container starts as root only so the
  entrypoint can hand a freshly mounted `/data` volume to `node`; it then
  `setpriv`s to `node`. The server and every agent shell command run as uid
  1000.
- **Migrations before traffic.** `node apps/generic-corp/dist/migrate.js`
  applies Postgres migrations and exits. Railway runs it as the pre-deploy
  command and Compose as a one-shot service, so a failed migration stops the
  deploy while the previous one keeps serving. The server still migrates on
  open; the advisory lock makes running both safe.
- **Readiness gates traffic.** Railway's health check and Compose's use
  `/ready` (database reachable, schema at the latest version). The image's
  own `HEALTHCHECK` uses `/health`.
- **Config as code.** `railway.toml` at the repository root holds the builder,
  Dockerfile path, pre-deploy command, health check and restart policy. The
  database, volume, variables and domain are account resources and stay in
  the runbook (`apps/generic-corp/DEPLOY.md`).
- **The shell runs in the app container.** On Railway there is no Docker
  sandbox. The app binds the plain terminal tool, so shell commands run in
  the app container as `node`, rooted at the agent's home on the volume,
  with an allowlisted environment and no access to the server's `/proc`
  entries (see Consequences).
- **CI builds and smoke-tests the image** (`generic-corp-image` workflow):
  migrate, start like Railway, readiness, auth, setup token, non-root user,
  tool binaries, read-only server code, no secrets reachable from an agent
  command, a Postgres restart, Chrome launch and clean shutdown.
- **The terminal tool no longer leaks the host environment.** Commands run
  through the agent-facing bash tool received the server's whole
  environment, because the bash tool hands its spawn hook `process.env` and
  the terminal plugin layered that over its allowlist. The hook now keeps
  only allowlisted keys unless `inheritProcessEnv` is set.
- **A dropped idle Postgres connection no longer crashes the server.**
  `plugin-storage-postgres` now listens for pool errors on pools it creates.

## Consequences

- Railway deploys need four things set up once by the owner: the Postgres
  service, the `/data` volume, the provider key variables and a public
  domain. The runbook lists them.
- Keep the app service at one replica. The volume attaches to one replica,
  agent turns run in-process, and v1 has a single owner.
- Agents' shell commands share the container and the uid with the server, so
  three measures keep the server's secrets (provider keys, `DATABASE_URL`,
  `GENERIC_AI_SECRETS_KEY`, the setup token) from them: the shell tool and
  the `rg`/`fd` helpers start commands with an allowlisted environment, never
  the server's; the `node` binary is execute-only, which makes the server
  non-dumpable so the kernel denies same-user reads of its
  `/proc/<pid>/environ` and memory; and `/app` is owned by root so agents
  cannot change the server code. A probe in the image smoke test checks the
  first two on every PR. A separate uid for agent commands was not used: the
  server would need root or a setuid helper to switch users. What remains
  (same-user file access under `/data`, the environment of non-node child
  processes such as some MCP servers, lifecycle hooks) is listed in
  `apps/generic-corp/DEPLOY.md` and belongs to R20.
- Chrome and its system libraries make up most of the image. `INSTALL_BROWSER=false`
  builds a much smaller image without the browser connector. arm64 builds (for example
  Compose on Apple silicon) skip Chrome, because Google does not publish it
  for Linux arm64.

## Alternatives Considered

- **Docker-in-Docker sandbox on Railway.** Not available on the platform, and
  privileged containers would widen the blast radius rather than narrow it.
- **Nixpacks/Railpack instead of a Dockerfile.** It would not reproduce the
  same image locally, and the monorepo build plus system packages (ripgrep,
  Chrome) need explicit steps anyway.
- **Running migrations only on server start.** Works, but a bad migration
  would surface as a crash loop of the new deployment instead of a failed
  pre-deploy step.
- **`RAILWAY_RUN_UID=0` to run everything as root.** Simpler volume handling,
  but agent shell commands would run as root.
