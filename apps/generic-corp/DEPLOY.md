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
commands run directly in the app container, starting in the agent's home
under `/data/agents`, as a separate unprivileged user, `agent`. The server
runs as `node`. Threat model and decision record:
[`docs/decisions/0064-agent-isolation-on-railway.md`](../../docs/decisions/0064-agent-isolation-on-railway.md).

- **Works:** shell commands, git, file tools, grep and find, package installs
  from the network allowlist (npm, PyPI, crates, Go modules, RubyGems,
  GitHub), the web tools and MCP connectors (which run in the server, not the
  shell), and installing tools into the agent's home with user-level installs
  (`HOME` is the agent's home).
- **Does not work:** anything that needs Docker (building or running
  containers), root (`apt-get install`), or a GUI.

**How agent commands are kept away from the server.** Provider keys,
`DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, the setup token and auth tokens live
in the server process; owner auth, runs and the company live in Postgres or,
locally, in `/data/company.sqlite`.

- **Separate user.** The shell tool runs each command through
  `sudo -n -u agent`. The image's sudoers rule lets `node` run commands as
  `agent` and nothing else; `agent` cannot use sudo at all. As `agent`, a
  command cannot read `/proc/<pid>/environ` of the server or of anything the
  server starts (MCP servers launched with `uvx` included), cannot signal
  those processes, and cannot read or write the server's files on `/data`.
  The entrypoint keeps `/data` closed to other users (it can only be passed
  through) and gives agent homes to the `agent` group, which `node` is in, so
  the server and agent commands both work there. On a timeout or abort the
  whole command, including anything it started in the background, is killed.
- **Environment.** Each command starts from an allowlist (`PATH`, `HOME`,
  `SHELL`, locale, temp dirs and the tool's own session variables), never the
  server's. The grep and find tools give `rg` and `fd` an allowlisted
  environment too, and lifecycle hook commands start from the same allowlist
  (a hook gets a server variable only when its config names it in `passEnv`).
- **File tools.** The agents' read, write, edit, ls, find and grep tools run
  inside the server process, as `node`. They only accept paths inside the
  agent's home, resolving symlinks first, so `/proc/self/environ`, server
  files and links pointing out of the home are refused. `read` may also open
  the shell tool's own saved output in the temp directory.
- **`/proc` as a second line.** The image makes the `node` binary
  execute-only, so Linux marks the server non-dumpable and even a process of
  the same user cannot read its environment or memory. This still protects
  the server if agent commands ever fall back to running as `node`.
- **Code.** `/app` is owned by root, so neither user can change the server
  code that runs on the next start.

The server logs which user agent commands run as at startup, and `/ready`
reports it as `agentIsolation` (`user` or `shared`). If the server cannot
switch to `agent` (for example a platform that blocks sudo), it logs a
`WARNING` and runs agent commands as `node`. Set
`GENERIC_CORP_AGENT_ISOLATION=required` to refuse to start instead, once the
first deploy shows `agentIsolation: user`. `off` turns the separate user off.

The image smoke test checks all of this on every PR. Its probe starts a
non-node child holding the secrets, runs commands through the agents' shell
tool and looks for the secret values in their environment and in every
`/proc/<pid>/environ` they can read, checks they run as `agent`, cannot read
or write server files on `/data`, can write in their home and are killed on a
timeout, then asks each file tool for paths outside the workspace.

**What remains**, and what a stronger setup would need:

- **Agents share one user with each other.** Every agent's commands run as
  `agent`, and agent homes share the `agent` group, so one agent's commands
  can read and change another agent's home, memory file and workspace. For a
  single-owner company this is the same trust level, but a prompt-injected
  agent could tamper with a colleague's memory. Closing it needs one OS user
  per agent, created when the agent is, which needs root or a privileged
  helper at runtime.
- **The network wall needs NET_ADMIN.** Agent commands reach the network
  only through the server's egress proxy on `127.0.0.1:3128`
  (`GENERIC_CORP_EGRESS_PORT`), which allows the hosts on the allowlist and
  logs every refusal to the owner's refused-actions list (`/api/refusals`).
  The entrypoint adds a firewall rule so the `agent` user's packets can go
  to that port and nowhere else (no other host, no DNS, not Postgres, not
  the app's own port), then drops `NET_ADMIN` before starting the server.
  That needs the capability when the container starts: `compose.yaml` adds
  it. Railway does not document a way to add capabilities, so expect
  `/ready` to show `"agentNetwork":"proxy-only"` there: commands are pointed
  at the proxy, and npm, pip, git, curl and Node all use it, but a command
  that deliberately ignores the proxy variables can still connect directly.
  `GENERIC_CORP_AGENT_NETWORK=required` refuses to start without the wall;
  `off` removes it. Allowlisted hosts accept uploads too (`git push`,
  `npm publish`) to any account whose credentials a command has, so a
  prompt-injected agent handed an outsider's token could push company files
  to that account; closing that needs a proxy that reads TLS traffic.
- **Resource limits are per process, not per agent.** Each agent command gets
  `ulimit` limits (4 GiB of memory and an hour of CPU per process, 4 GiB
  files, 4096 open files, 1024 processes for the `agent` user) and runs at
  niceness 10, so one heavy script cannot starve the server. Railway does not
  expose cgroup controls inside the container, so there is no total CPU or
  memory cap per agent; Railway's service limits cap the whole container.
- **A symlink race in the file tools.** The file tools check a path and then
  open it. An agent command that swaps a directory in its home for a symlink
  at exactly the right moment could make a file tool (running as `node`)
  read or write outside the home. Closing it needs kernel path resolution
  (`openat2` with `RESOLVE_BENEATH`) or file tools that run as `agent`.
- **MCP server arguments are public.** Any user can read any process's
  command line, so put MCP server credentials in `env` (protected) and never
  in `args`.
- **Confirm on Railway.** After the first deploy, check `/ready` shows
  `"agentIsolation":"user"`, then `railway ssh` into the app service and run:

  ```bash
  PROBE_EXPECT_ISOLATION=user generic-corp-entrypoint \
    node apps/generic-corp/scripts/agent-env-probe.mjs \
    "$ANTHROPIC_API_KEY" "$DATABASE_URL"
  ```

  It ends with `Agent commands run as agent: ...` on success.

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
