# Deploying Generic Corp

Generic Corp ships as one Docker image. Railway runs it in production and
Docker Compose runs the same image locally with Postgres. Decision record:
[`docs/decisions/0062-generic-corp-deploy-packaging.md`](../../docs/decisions/0062-generic-corp-deploy-packaging.md).

| File | What it does |
| --- | --- |
| [`Dockerfile`](Dockerfile) | Production image. Build from the repo root. |
| [`docker-entrypoint.sh`](docker-entrypoint.sh) | Hands the `/data` volume to the `node` user, then drops root. |
| [`compose.yaml`](compose.yaml) | Local stack: Postgres, a one-shot migration, the app. |
| [`../../railway.toml`](../../railway.toml) | Railway config as code: Dockerfile, pre-deploy migration, health check, restart policy. |
| [`scripts/smoke-image.sh`](scripts/smoke-image.sh) | Smoke test for a built image. CI runs it on every relevant PR. |

## What runs where

- **Server:** `node apps/generic-corp/dist/run.js`, as the `node` user (uid
  1000), on `PORT` (Railway sets it; 3000 otherwise) and `0.0.0.0`.
- **Migrations:** `node apps/generic-corp/dist/migrate.js` applies Postgres
  schema migrations and exits. Railway runs it before each deploy takes
  traffic. Without `DATABASE_URL` it does nothing.
- **Health:** `GET /health` answers while the process is up. `GET /ready`
  answers 200 only when the database is reachable and the schema is current,
  and 503 otherwise. Railway and Compose wait on `/ready`.
- **Data:** Postgres holds runs, the queue, agents, owner auth and the
  company. `/data` (`GENERIC_CORP_DATA_DIR`) holds agent homes, memory files,
  workspaces and run artifacts, so it must be a volume.
- **Agent tools:** bash, git, ripgrep and fd are in the image. On amd64 the
  image also has Google Chrome and the pinned Playwright MCP package for the
  browser connector.

### Shell commands and sandboxing

Railway does not let a container start other containers, so there is no
Docker sandbox there. Generic Corp does not use one: its agents' shell
commands run directly in the app container, as `node`, starting in the
agent's home under `/data`.

- **Works:** shell commands, git, file tools, grep and find, outbound network
  access (web search, APIs, MCP servers, the browser connector), and
  installing tools into the agent's home with user-level installs.
- **Does not work:** anything that needs Docker (building or running
  containers), root (`apt-get install`), or a GUI.

**Keeping the server's secrets away from agent commands.** Provider keys,
`DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, the setup token and auth tokens live
in the server process. Agent commands cannot read them by either route:

- **Environment.** The shell tool starts every command with an environment
  built from an allowlist (`PATH`, `HOME`, `SHELL`, locale, temp dirs and the
  tool's own session variables), never the server's. The grep and find tools
  give `rg` and `fd` an allowlisted environment too.
- **`/proc`.** The image makes the `node` binary execute-only. Linux marks a
  process that runs a binary it cannot read as non-dumpable, and then refuses
  other processes of the same user access to its `/proc/<pid>/environ` and
  memory. So an agent command, which runs as `node` like the server, cannot
  read the server's environment.
- **Code.** `/app` is owned by root, so agent commands cannot change the
  server code that runs on the next start.
- **File tools.** The agents' read, write, edit, ls, find and grep tools run
  inside the server process, so they could otherwise read the server's own
  `/proc/self/environ`. They only accept paths inside the agent's home, and
  resolve symlinks before checking, so `/proc/self/environ`, `/data/...` of
  other agents and links pointing out of the home are refused.
- **Hooks.** Lifecycle hook commands start from the same allowlisted
  environment as agent commands. A hook gets a server variable only when its
  config names it in `passEnv`.

The image smoke test checks all of this on every PR, with a probe that runs a
command through the agents' shell tool and looks for the server's secret
values in its environment and in every `/proc/<pid>/environ` it can read, then
asks each file tool for paths outside the workspace.

**What remains** (stronger isolation is roadmap item R20):

- Agent commands run as the same user as the server, so they can read and
  write everything `node` can: every agent's home and workspace under
  `/data`, and the SQLite database when there is no `DATABASE_URL` (on
  Railway there is one, so the database is not on disk).
- Child processes the server starts that are not `node` (for example an MCP
  server launched with `uvx` or a native binary) are ordinary processes, so
  an agent command can read their environment, including credentials
  configured for that MCP server. MCP servers launched with `npx` or `node`
  are protected like the server.
- Agent commands share the network with the server. They can reach the
  Postgres host on Railway's private network, but not its password.
- The `/proc` protection relies on standard Linux behaviour. After the first
  deploy, confirm it on Railway with `railway ssh` into the app service and:

  ```bash
  generic-corp-entrypoint node apps/generic-corp/scripts/agent-env-probe.mjs \
    "$ANTHROPIC_API_KEY" "$DATABASE_URL"
  ```

  It prints `None of the 2 secret values reached the agent command.` on
  success.

## Local testing with Docker Compose

From the repo root:

```bash
export ANTHROPIC_API_KEY=...   # the default models are Anthropic's
docker compose -f apps/generic-corp/compose.yaml up --build
```

The first build takes a few minutes. When `app` is healthy, find the setup
token:

```bash
docker compose -f apps/generic-corp/compose.yaml logs app | grep -A1 "setup token"
```

Open <http://localhost:3000/auth/login>, paste the token and register a
passkey. The token changes on every restart until a passkey exists; set
`GENERIC_AI_OWNER_SETUP_TOKEN` (16+ characters) to pin it.

Useful variations:

- `INSTALL_BROWSER=false docker compose ... up --build` builds without Chrome
  (faster, smaller). On Apple silicon and other arm64 machines Chrome is
  skipped anyway, because Google does not publish it for Linux arm64.
- `GENERIC_CORP_PORT=3100` serves on another host port.
- `docker compose ... down -v` deletes the database and agent data.

To check an image the way CI does:

```bash
docker build -f apps/generic-corp/Dockerfile -t generic-corp:local .
apps/generic-corp/scripts/smoke-image.sh generic-corp:local --browser
```

## First deploy on Railway

Railway reads `railway.toml` at the repo root, so the build, the pre-deploy
migration, the health check and the restart policy need no clicks. These
pieces live in the Railway account and are set once:

1. **Project and database.** Create a project and add the **PostgreSQL**
   database service.
2. **App service.** Add a service from the GitHub repo `neill-k/generic-ai`,
   branch `main`. Leave the root directory empty (the build needs the whole
   repo). Railway picks up `railway.toml` and builds
   `apps/generic-corp/Dockerfile`.
3. **Variables** on the app service:

   | Variable | Value | Needed |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database service) | Yes |
   | `ANTHROPIC_API_KEY` | Anthropic API key | Yes, for the default models |
   | `GENERIC_AI_OWNER_SETUP_TOKEN` | A random string of 16+ characters | Recommended: pins the first-login token across restarts |
   | `OPENAI_API_KEY` and other provider keys | As needed | Only for roles configured to use them |
   | `GENERIC_CORP_COMPANY_FILE` | Path to a company YAML | Optional |
   | `GENERIC_AI_AUTH_TOKEN` | 16+ characters | Optional break-glass bearer token for scripts |

   Railway sets `PORT` and, once a domain exists, `RAILWAY_PUBLIC_DOMAIN`.
   The app uses the domain as its passkey origin and trusts Railway's proxy
   headers for sign-in rate limiting. Do not set `GENERIC_CORP_HOST`; the
   image already listens on `0.0.0.0`.
4. **Volume.** Attach a volume to the app service mounted at `/data`. The
   entrypoint gives it to the `node` user on start; do not set
   `RAILWAY_RUN_UID`.
5. **Domain.** Under Networking, generate a Railway domain (or add a custom
   one) pointing at the port the app listens on (`PORT`).
6. **Replicas.** Keep the app service at one replica. The volume attaches to
   one replica, agent turns run in-process, and v1 has a single owner.
7. **Deploy**, then sign in:
   - The deploy runs the migration first. Its output (`Applied migrations
     ...`) is in the deployment's pre-deploy logs.
   - When the deployment is healthy, open the app service's **Deploy
     Logs** and search for `setup token`. The line below it is the token
     (or it is the value you set in `GENERIC_AI_OWNER_SETUP_TOKEN`). With the
     Railway CLI: `railway logs --service <app service> | grep -A1 "setup token"`.
   - Open `https://<your domain>/auth/login`, paste the token and register a
     passkey. After that the token stops working and no longer prints.

### Later deploys

Pushes to `main` redeploy. A failed migration fails the pre-deploy step and
the previous deployment keeps serving. With a volume attached Railway stops
the old deployment before starting the new one, so expect a short gap.

### Troubleshooting

- **Deployment never becomes healthy:** `/ready` is returning 503. Check the
  deploy logs for the database error; usually `DATABASE_URL` is missing or
  not a reference to the Postgres service.
- **Passkey registration fails:** the origin must match. Use the Railway
  domain or set `GENERIC_AI_PUBLIC_URL` to the custom domain.
- **Lost the passkey:** set `GENERIC_AI_AUTH_TOKEN` and use it as a bearer
  token to reach the API, or reset owner auth in the database.
