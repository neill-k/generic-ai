# apps/generic-corp

Generic Corp is the flagship app built on Generic AI. One owner runs a company
of persistent, goal-driven agents: the owner chats with a CEO agent, work is
delegated down an org chart and results come back up, and a dashboard shows
the conversation, the org chart, the board, agent activity, costs and
approvals. Agents do generic work, not only software work.

The decision to build it here, and the product decisions behind it, are in
[`docs/decisions/0046-generic-corp-app-on-generic-ai.md`](../../docs/decisions/0046-generic-corp-app-on-generic-ai.md).

## Status

The app server (roadmap R13) is in. It runs the company and serves a JSON API
with live events. The dashboard, approvals view, secrets screen and Docker
image come next.

- **Company.** `company.ts` defines the org chart as plain data (YAML via
  `GENERIC_CORP_COMPANY_FILE`, or the built-in default: a CEO, VPs for
  research, operations and engineering, and one contributor under each). Each
  tier (`ceo`, `vp`, `ic`) has a default model, and any agent can override it
  (D3). Agents default to the `builder` role kind.
- **Runtime.** `runtime.ts` seeds the persistent agents, runs the durable
  delegation cascade (`@generic-ai/plugin-delegation`), keeps chat threads with
  the CEO, and publishes live events. An owner message starts one root task for
  the CEO; the reply is that task's result once its goal checks pass.
- **Executor.** `executor.ts` runs every agent turn on the native runtime with
  the agent's own model, file and shell tools rooted at the agent's home, and
  persists each harness run so traces and costs are kept.
- **Storage.** Postgres when `DATABASE_URL` is set, otherwise SQLite under the
  data directory. Agents, threads and owner auth records share the backend.
- **Auth.** Owner passkeys and API tokens (`@generic-ai/plugin-auth-identity`)
  guard every API route. `GENERIC_CORP_INSECURE_NO_AUTH=1` turns auth off, and
  is refused unless the server listens on loopback.

## API

All routes are under `/api` and need an owner credential: reads need
`runs:read`, anything that starts or stops work needs `runs:execute`.

| Method and path | What it does |
| --- | --- |
| `GET /api/company` | Company name, mission, CEO id, storage driver |
| `GET /api/org-chart` | The org chart as a tree, with each agent's tier, model and active task count |
| `GET /api/agents`, `GET /api/agents/:id` | Agents; one agent's record, memory file, reporting line and recent tasks |
| `GET /api/agents/:id/costs` | One agent's usage and cost |
| `GET /api/threads`, `POST /api/threads` | List chat threads; start one with `{"text": "..."}` |
| `GET /api/threads/:id`, `POST /api/threads/:id/messages` | A thread with each message and the CEO's reply; send another message |
| `PATCH /api/threads/:id` | Rename a thread |
| `GET /api/tasks?status=&agentId=&root=1&limit=` | Tasks, newest first |
| `GET /api/tasks/:id`, `/tree`, `/events` | A task and its children, its whole cascade, its event log and harness run events |
| `POST /api/tasks/:id/cancel` | Cancel a task and everything it delegated |
| `GET /api/board` | Tasks in columns by status |
| `GET /api/costs` | Tokens and dollars by agent, model and owner request, and cost per completed request |
| `GET /api/events` | Server-sent events: `task.*`, `thread.updated`, `runtime.error`. Supports `Last-Event-ID` |

`GET /health` and `GET /ready` are public; `/ready` checks the database.
`/auth/login` is the owner sign-in page.

## Running it

```bash
npm run build
GENERIC_CORP_DATA_DIR=./.data ANTHROPIC_API_KEY=... npm run -w @generic-ai/app-generic-corp start
```

The first start prints a one-time setup token for `/auth/login` to register
the owner passkey. For scripts, set `GENERIC_AI_AUTH_TOKEN` (16 characters or
more) and send it as a bearer token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `GENERIC_CORP_HOST` | `127.0.0.1` (`0.0.0.0` on Railway) | Listen address |
| `GENERIC_CORP_DATA_DIR` | `~/.generic-corp` | SQLite database, agent homes, run artifacts |
| `DATABASE_URL` | none | Use Postgres instead of SQLite |
| `GENERIC_CORP_COMPANY_FILE` | built-in company | YAML org chart |
| `GENERIC_CORP_WORKERS` | `true` | Run agent turns in this process |
| `GENERIC_AI_PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` | none | Public origin for passkeys |
| `GENERIC_AI_OWNER_SETUP_TOKEN` | printed at start | Pins the first-passkey setup token |
| `GENERIC_AI_AUTH_TOKEN` | none | Break-glass static owner token |

Known limits: live events are per process, so with several worker processes
each streams the turns it runs and the dashboard refetches on reconnect. The
agents' shell runs on the host, not in a sandbox; sandboxing in production is
roadmap item R20.

## Layering

Apps sit above every other layer. This workspace may depend on any
`@generic-ai/*` package; nothing under `packages/` or `examples/` may depend on
it. Generic Corp concepts such as the CEO, org chart and board stay here unless
an ADR promotes a general form into the SDK or a plugin. See
[`docs/package-boundaries.md`](../../docs/package-boundaries.md).

## Commands

From the repo root:

```bash
npm run -w @generic-ai/app-generic-corp build
npm test -- apps/generic-corp/src
```
