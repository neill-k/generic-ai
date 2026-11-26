# apps/generic-corp

Generic Corp is the flagship app built on Generic AI. One owner runs a company
of persistent, goal-driven agents: the owner chats with a CEO agent, work is
delegated down an org chart and results come back up, and a dashboard shows
the conversation, the org chart, the board, agent activity, costs and
approvals. Agents do generic work, not only software work.

The decision to build it here, and the product decisions behind it, are in
[`docs/decisions/0046-generic-corp-app-on-generic-ai.md`](../../docs/decisions/0046-generic-corp-app-on-generic-ai.md).

## Status

The app server (roadmap R13) is in. It runs the company, gives its agents the
generic-work toolkit, serves a JSON API with live events, and serves the owner
dashboard at `/` with an approvals inbox.

- **Company.** `company.ts` defines the org chart as plain data (YAML via
  `GENERIC_CORP_COMPANY_FILE`, a template via `GENERIC_CORP_TEMPLATE`, or the
  default `generic-corp` template: a CEO, VPs for research, operations and
  engineering, and one contributor under each). Each
  tier (`ceo`, `vp`, `ic`) has a default model, and any agent can override it
  (D3). Agents default to the `builder` role kind.
- **Runtime.** `runtime.ts` seeds the persistent agents, runs the durable
  delegation cascade (`@generic-ai/plugin-delegation`), keeps chat threads with
  the CEO, and publishes live events. An owner message starts one root task for
  the CEO; the reply is that task's result once its goal checks pass.
- **Executor.** `executor.ts` runs every agent turn on the native runtime with
  the agent's own model and the toolkit below, rooted at the agent's home, and
  persists each harness run so traces and costs are kept.
- **Toolkit.** `toolkit.ts` gives every agent tools for generic work (D6), not
  only code: files and a shell, `web_fetch` and `web_search`, `document_read`,
  `document_extract` and `document_write` (PDF, Word, Excel, CSV, HTML in;
  Markdown, HTML, Word, Excel, CSV out), and the company's MCP connectors for
  email, calendar, chat, documents, a headless browser and payments. Connector
  tools that send, write to an outside system or spend money carry outward
  effect tags for the approvals gate.
- **Secrets.** Credentials come from the secrets vault
  (`@generic-ai/plugin-secrets`): `GENERIC_AI_SECRET_<NAME>` variables, files in
  `GENERIC_AI_SECRETS_DIR`, or the encrypted store when `GENERIC_AI_SECRETS_KEY`
  is set. Search keys and MCP `${NAME}` placeholders resolve host-side, so
  agents never see them. An agent's `secrets:` list lets it use named secrets
  in its own tool calls as `{{secret:NAME}}`.
- **Dashboard.** `public/` holds a no-build page (`dashboard.ts` serves it at
  `/` with a strict CSP): chat with the CEO, the org chart with each agent's
  memory and tasks, the board, costs, the agents' tools and connectors, and a
  secrets screen that shows which secrets are missing and saves new ones. It
  refreshes from `/api/events`, and a signed-out browser goes to `/auth/login`.
- **Approvals.** Outward actions wait for the owner (`@generic-ai/plugin-approvals`):
  sending messages, writing to outside systems, spending money and writing MCP
  tools, or whatever `approvals:` in the company file says. A gated call ends
  the agent's turn and its task waits without holding a worker. Approving runs
  the exact call once when the agent repeats it; the task resumes on its own.
- **Templates and goals.** `templates/` holds ready-made companies (see
  "Company templates" below). A company lists goals it knows how to pursue;
  the owner starts from one on the dashboard, and the CEO's task only
  succeeds when the goal's checks pass on the whole team's work.
- **Skills.** `skills/` holds the standup, review and compound-learning
  skills (Agent Skills format). Every agent has them, plus any skills it saves
  for itself under `.agents/skills/` in its home.
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
| `GET /api/threads`, `POST /api/threads` | List chat threads; start one with `{"text": "..."}`, or `{"goalId": "..."}` to start from a company goal (the text defaults to the goal's request) |
| `GET /api/threads/:id`, `POST /api/threads/:id/messages` | A thread with each message and the CEO's reply; send another message |
| `PATCH /api/threads/:id` | Rename a thread |
| `GET /api/tasks?status=&agentId=&root=1&limit=` | Tasks, newest first |
| `GET /api/tasks/:id`, `/tree`, `/events` | A task and its children, its whole cascade, its event log and harness run events |
| `POST /api/tasks/:id/cancel` | Cancel a task and everything it delegated |
| `GET /api/board` | Tasks in columns by status |
| `GET /api/costs` | Tokens and dollars by agent, model and owner request, and cost per completed request |
| `GET /api/approvals?status=pending`, `GET /api/approvals/:id` | Approval requests, with each one's audit events |
| `POST /api/approvals/:id/approve`, `/reject` | Decide a request (`{"comment": "..."}` optional). Needs `approvals:decide` |
| `GET /api/approvals/stream` | Server-sent approval events |
| `GET /api/secrets` | Secret names the company uses or holds, where each is set, and who uses it. Never values |
| `PUT /api/secrets/:name`, `DELETE /api/secrets/:name` | Save or remove a secret in the encrypted store (`{"value": "..."}`). Needs `tokens:manage` and `GENERIC_AI_SECRETS_KEY` |
| `GET /api/goals` | The company's goals: request, definition of done and checks |
| `GET /api/tools` | The agents' tools and skills, the web search backend and each MCP connector's state |
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
| `GENERIC_CORP_COMPANY_FILE` | none | YAML company file; wins over the template |
| `GENERIC_CORP_TEMPLATE` | `generic-corp` | Company template: `generic-corp`, `research-desk` or `back-office` |
| `GENERIC_CORP_WORKERS` | `true` | Run agent turns in this process |
| `GENERIC_CORP_WORKER_CONCURRENCY` | `4` | Agent turns this process runs at once (1 to 64), across different agents |
| `GENERIC_CORP_TURN_LEASE_MS` | `30000` | How long a turn's lease lasts before another worker may take over after a crash (at least 1000) |
| `GENERIC_AI_PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` | none | Public origin for passkeys |
| `GENERIC_AI_OWNER_SETUP_TOKEN` | printed at start | Pins the first-passkey setup token |
| `GENERIC_AI_AUTH_TOKEN` | none | Break-glass static owner token |
| `GENERIC_AI_SECRET_<NAME>` | none | A secret named `<NAME>`, for example `GENERIC_AI_SECRET_BRAVE_API_KEY` |
| `GENERIC_AI_SECRETS_KEY` | none | Master key (`openssl rand -hex 32`) for secrets stored in the database |

### Tools in the company file

```yaml
name: Generic Corp
tools:
  # Optional. Without it, a BRAVE_API_KEY or TAVILY_API_KEY secret turns search on.
  webSearch: { provider: brave, apiKey: "${BRAVE_API_KEY}" }
  mcp:
    servers:
      - id: mail
        connector: email
        transport: http
        url: "${MAIL_MCP_URL}"
        headers: { Authorization: "Bearer ${MAIL_MCP_TOKEN}" }
      - id: web
        connector: browser   # headless Playwright MCP; the image needs npx and Chromium
agents:
  - id: ceo
    role: ceo
  - id: researcher
    role: researcher
    reportsTo: ceo
    secrets: [CRM_API_KEY]
```

See `@generic-ai/plugin-mcp` for every server field and how connector tools
are classified.

Known limits: live events are per process, so with several worker processes
each streams the turns it runs and the dashboard refetches on reconnect. The
agents' shell runs on the host, not in a sandbox; sandboxing in production is
roadmap item R20.

## Company templates

Each folder under `templates/` is a company a person can start from:

| Template | Org chart | Goals |
| --- | --- | --- |
| `generic-corp` | CEO; VPs of research, operations and engineering; one contributor each | Launch plan, tool comparison |
| `research-desk` | Managing director; heads of research and editorial; market and data analysts, a fact checker | Market brief |
| `back-office` | General manager; heads of finance, operations and support; bookkeeper, coordinator, support agent. Email, calendar and documents connectors (off until their secrets are set); payments refused | Month-end close, support replies |

A template folder has:

- `company.yaml`: the company file (org chart, models per tier, tools and
  connectors, secret grants, approvals) plus `goals`. Each goal has the
  owner's `request` and a goal spec: objective, definition of done, and
  validators covering NOVA's three checks (a number, a rubric, the actions
  taken) and usually an output schema.
- `evals.yaml`: its goal eval suite (`@generic-ai/sdk` goal evals). Cases
  name a goal by id, can add held-out validators the agents never see, and
  the suite's gate sets the pass rate and pass^k a live run must reach.
- `replays/`: recorded agent turns, search results, pages and rubric
  judgments for each case.

How goals are checked. A goal on the CEO's task is the company's goal, so
`goals.ts` checks it against the whole team: the trace includes every run
delegated under the CEO (each event tagged with the agent that ran it), and
when the CEO's reply ends with a fenced JSON block naming a deliverable
(`{"deliverable": {"agent": "analyst", "path": "workspace/brief.md"}}`), that
file is read from the agent's home as the `deliverable` artifact, with
`deliverableWords`, `deliverableLines` and `deliverableLinks` metrics. Rubrics
use a model judge on the company's VP model.

Evals. `npm run evals -w @generic-ai/app-generic-corp` replays every
template's suite offline: a fresh company per attempt, the recorded turns on a
scripted model, and the real cascade, tools, validators and scoring. It exits
1 when any gate fails, and CI runs it after the build. Add `--live` to run on
the real models with a model judge (needs provider keys; this is what the
reliability gate runs), `--template <id>` to pick one, `--trials <n>` and
`--out <dir>` for reports. A replay that drifts from the recorded path (an
agent asks for a turn the recording does not have) fails the attempt.

Reliability gate (R19). `.github/workflows/template-evals-live.yml` runs the
same suites with `--live` and fails when any gate fails; the job summary shows
each suite's pass rate, pass^k, and tokens and dollars per completed goal, and
the reports are uploaded as an artifact. Because every run spends money:

- it runs only when started by hand (Actions, "Reliability gate", Run
  workflow), or weekly once the repository variable `TEMPLATE_EVALS_SCHEDULE`
  is `on` (it is off by default);
- it needs the `ANTHROPIC_API_KEY` Actions secret, and without it skips with a
  notice and spends nothing. `BRAVE_API_KEY` or `TAVILY_API_KEY` is optional
  but the research goals fail their search check without one;
- the whole run stops at `--max-usd` (default 50) and `--max-tokens` (default
  40,000,000, cache reads included). Each agent turn starts with what is left
  of the cap as its harness budget, so the turn in flight stops with
  `budget_exceeded`; rubric judgments count against the cap too; attempts that
  would start after it are not run and count as failures. Locally the CLI
  applies the same defaults to `--live`, exits 3 when the provider key is
  missing, and with `--out` writes `summary.json` with the verdict and spend.

A full run is 5 goals with 5 attempts each. At list prices a single attempt is
expected to cost roughly $1 to $2 (mostly Sonnet 5.5 turns, with prompt caching),
so about $25 to $50 for a full run. Start with `trials: 1` (about $5 to $10) to
calibrate before a full run.

To add a template, copy a folder, change `company.yaml`, and record a replay
for each goal. `templates.test.ts` checks that every goal has a case, a replay,
and numeric, rubric and trace validators.

## End-to-end, crash and load tests

`e2e/` holds Playwright tests that start a real server (dashboard, API, cascade,
approvals gate, durable queue) on a scripted model, so no key is needed and
nothing is spent. CI runs them in the `e2e` job of the quality gate.

```bash
npm run build
npm exec -w @generic-ai/app-generic-corp -- playwright install chromium  # once
npm run e2e -w @generic-ai/app-generic-corp
```

- `golden-flows.spec.ts`: chat with the CEO, delegation to a VP (board and org
  chart), and an outward action that waits for the owner's approval and then
  runs exactly once.
- `crash-resume.spec.ts`: the process is killed (SIGKILL) mid-turn; a new
  process over the same data picks the cascade up once the lease lapses and
  answers the owner, with the work done once.
- `load.spec.ts`: many requests at once while a dashboard polls every read
  endpoint. Every request must be answered correctly with no HTTP errors.

An agent never runs two turns at once (each agent has one home and one memory
file), while different agents' turns run side by side. Every owner request goes
through the CEO, so one process handles about one CEO turn at a time; the load
test prints its numbers. For a heavier local run:
`LOAD_THREADS=200 LOAD_MODEL_DELAY_MS=250 npm run e2e -w @generic-ai/app-generic-corp -- e2e/load.spec.ts`.

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
