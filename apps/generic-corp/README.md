# apps/generic-corp

Generic Corp is the flagship app built on Generic AI. One owner runs a company
of persistent, goal-driven agents: the owner chats with a CEO agent, work is
delegated down an org chart and results come back up, and a dashboard shows
the conversation, the org chart, the board, agent activity, costs and the
owner's permissions. Agents do generic work, not only software work.

The decision to build it here, and the product decisions behind it, are in
[`docs/decisions/0046-generic-corp-app-on-generic-ai.md`](../../docs/decisions/0046-generic-corp-app-on-generic-ai.md).

**Run it on your machine:** [`RUN-LOCALLY.md`](RUN-LOCALLY.md) (one command,
then sign in with Claude).

## Status

The app server (roadmap R13) is in. It runs the company, gives its agents the
generic-work toolkit, serves a JSON API with live events, and serves the owner
dashboard at `/` with a permissions page and the refused-actions list.

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
  the agent's own model and the toolkit below, rooted at the company root (see
  "Company drive"), and persists each harness run so traces and costs are kept.
- **Company drive.** `drive.ts` keeps everything agents work on under
  `<data dir>/company`: `drive/` is the shared drive every agent reads and
  writes (`drive/inbox/` for what the owner hands in,
  `drive/goals/<goalId>/` as each goal's working folder and
  `drive/goals/<goalId>/deliverables/` for finished work), and
  `agents/<id>/` is each agent's home with `workspace/` as its scratch folder.
  Paths are relative to the company root, so the same path means the same
  file to every agent, the goal checks and the owner. Agents are told to hand
  work to each other as drive paths, not pasted text. A long result is saved to
  `drive/goals/<goalId>/handoffs/` and its manager gets an excerpt plus the path. The owner browses,
  uploads, previews and downloads drive files, drops files into a chat, and
  sees finished work on the deliverables shelf. Cancelling a goal keeps its
  folder, marked abandoned, with an `ABANDONED.md` note.
- **Toolkit.** `toolkit.ts` gives every agent tools for generic work (D6), not
  only code: files and a shell, `web_fetch` and `web_search`, `document_read`,
  `document_extract` and `document_write` (PDF, Word, Excel, CSV, HTML in;
  Markdown, HTML, Word, Excel, CSV out), and the company's MCP connectors for
  email, calendar, chat, documents, a headless browser and payments. Connector
  tools that send, write to an outside system or spend money carry outward
  effect tags the permissions gate checks.
- **Secrets.** Credentials come from the secrets vault
  (`@generic-ai/plugin-secrets`): `GENERIC_AI_SECRET_<NAME>` variables, files in
  `GENERIC_AI_SECRETS_DIR`, or the encrypted store when `GENERIC_AI_SECRETS_KEY`
  is set. Search keys and MCP `${NAME}` placeholders resolve host-side, so
  agents never see them. An agent's `secrets:` list lets it use named secrets
  in its own tool calls as `{{secret:NAME}}`.
- **The app.** `web/` is the owner's app: Preact, bundled by Vite into
  `dist/web` (`npm run build` runs both `tsc` and `vite build`; `npm run dev:web`
  serves it with hot reload against a server on port 8787). `dashboard.ts` serves
  it at `/` with a strict CSP. Goals is the home screen: each goal shows its
  definition of done as a live checklist, who is on it, what was delivered and
  what it used, and the owner edits what done means in a side panel. The org chart
  opens each agent's current work and memory. It refreshes from
  `/api/events?unnamed=1`, and a signed-out browser goes to `/auth/login`.
  `public/` is the earlier no-build dashboard, served at `/classic/` until its
  remaining screens (activity, drive, usage, permissions and refused actions,
  tools, secrets, Claude sign-in) move.
- **Permissions.** `permissions.ts`: the owner sets broad categories once
  (read outside systems: on; send messages, spend money, write to outside
  systems: off; GitHub pushes, pull requests and green-check merges in the
  repos the owner picks; the shell's network allowlist; standing rules). Every
  tool call is checked against them. An action outside them fails on the spot
  with the reason, the agent finds another route, and the refusal lands on the
  refused-actions list. Nothing waits for the owner. Permissions live in host
  storage that no agent tool reaches; `permissions:` in the company file sets
  the starting values, and the owner's saved ones replace them. Every agent
  turn starts with the standing rules and what is off.
- **GitHub.** Connect GitHub on the Permissions page with a fine-grained token
  (or `GENERIC_CORP_GITHUB_TOKEN`). Agents can then read the repositories it can
  see, and push branches, open pull requests and merge only in the repositories
  you tick, merges only with all checks green (`src/github.ts`, ADR 0070).
- **Network wall.** Agent shell commands reach the network only through an
  allowlisting egress proxy, enforced by a firewall rule in the image (see
  `egress.ts`, DEPLOY.md and ADR 0070). Refusals land on the same list.
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
| `GET /api/threads`, `POST /api/threads` | List chat threads; start one with `{"text": "..."}`, or `{"goalId": "..."}` to start from a company goal (the text defaults to the goal's request). `"attachments": ["drive/inbox/..."]` hands the CEO drive files |
| `GET /api/threads/:id`, `POST /api/threads/:id/messages` | A thread with each message and the CEO's reply; send another message |
| `PATCH /api/threads/:id` | Rename a thread |
| `GET /api/tasks?status=&agentId=&root=1&limit=` | Tasks, newest first |
| `GET /api/tasks/:id`, `/tree`, `/events` | A task and its children, its whole cascade, its event log and harness run events |
| `POST /api/tasks/:id/cancel` | Cancel a task and everything it delegated |
| `GET /api/board` | Tasks in columns by status |
| `GET /api/costs` | Tokens and dollars by agent, model and owner request, and cost per completed request |
| `GET /api/permissions` | The permissions in force and whether the owner has saved them |
| `PUT /api/permissions`, `DELETE /api/permissions` | Change any of them (fields left out keep their value), or go back to the company file's. Needs `tokens:manage` |
| `GET /api/connectors/github` | GitHub connection (account, no token) and the repositories it can see, each marked `writable` when the owner opened it to agents. Needs `tokens:manage` |
| `POST /api/connectors/github`, `DELETE /api/connectors/github` | Connect with `{"token"}` (checked against GitHub, kept on the server) or disconnect. Which repos agents may write to is `github.repos` in `PUT /api/permissions`. Needs `tokens:manage` |
| `POST /api/connectors/github/push` | Push a goal's deliverables to a branch: `{"goalId", "repo", "branch", "message"?, "path"?, "openPullRequest"?: {"title", "body"?}}`. Never the default branch. Needs `tokens:manage` |
| `GET /api/refusals?limit=` | Actions refused on the spot (permissions and network), newest first |
| `GET /api/secrets` | Secret names the company uses or holds, where each is set, and who uses it. Never values |
| `PUT /api/secrets/:name`, `DELETE /api/secrets/:name` | Save or remove a secret in the encrypted store (`{"value": "..."}`). Needs `tokens:manage` and `GENERIC_AI_SECRETS_KEY` |
| `GET /api/goals` | The company's goals: request, definition of done and checks |
| `GET /api/drive?path=drive/...` | A drive folder's files and folders |
| `GET /api/drive/file?path=&download=1` | A drive file: shown in the browser for safe types (HTML and SVG as plain text), downloaded with `download=1` |
| `PUT /api/drive/file?path=&overwrite=1` | Upload a file (the request body is the file). Refuses to replace one without `overwrite=1` |
| `POST /api/drive/inbox?name=` | Upload into `drive/inbox/` under a free name, for files dropped into a chat |
| `POST /api/drive/folder`, `DELETE /api/drive?path=` | Create a folder (`{"path": "drive/..."}`); delete a file or empty folder |
| `GET /api/deliverables` | The deliverables shelf: every goal's folder, status (`active`, `done`, `failed`, `abandoned`) and finished files |
| `GET /api/tools` | The agents' tools and skills, the web search backend and each MCP connector's state |
| `GET /api/events` | Server-sent events: `task.*`, `thread.updated`, `drive.updated`, `drive.goal.updated`, `runtime.error`. Supports `Last-Event-ID` |

`GET /health` and `GET /ready` are public; `/ready` checks the database and
reports `agentIsolation` and `agentNetwork`.
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
| `GENERIC_CORP_DATA_DIR` | `~/.generic-corp` | SQLite database, run artifacts, `sessions/` (each agent's saved conversation per goal, used to resume a turn after a restart), and `company/` (the drive and agent homes) |
| `DATABASE_URL` | none | Use Postgres instead of SQLite |
| `GENERIC_CORP_COMPANY_FILE` | none | YAML company file; wins over the template |
| `GENERIC_CORP_TEMPLATE` | `generic-corp` | Company template: `generic-corp`, `research-desk` or `back-office` |
| `GENERIC_CORP_WORKERS` | `true` | Run agent turns in this process |
| `GENERIC_CORP_WORKER_CONCURRENCY` | `4` | Agent turns this process runs at once (1 to 64), across different agents |
| `GENERIC_CORP_TURN_LEASE_MS` | `30000` | How long a turn's lease lasts before another worker may take over after a crash (at least 1000) |
| `GENERIC_CORP_NO_PROGRESS_MINUTES` | `15` | A turn with no tool activity for this long (and no tool still running) is stopped and retried; a turn also stops after 8 identical tool calls in a row. Turns have no fixed time limit (1 to 1440) |
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
  connectors, secret grants, starting permissions) plus `goals`. Models from
  Anthropic and OpenAI are supported; any other provider is untested, and the
  server logs a line at startup for each untested model the company uses. Each goal has the
  owner's `request` and a goal spec: objective, definition of done, and
  validators covering NOVA's three checks (a number, a rubric, the actions
  taken) and usually an output schema.
- `evals.yaml`: its goal eval suite (`@generic-ai/sdk` goal evals). Cases
  name a goal by id, can add held-out validators the agents never see, and
  the suite's gate sets the pass rate and pass^k a live run must reach.
- `replays/`: recorded agent turns, search results, pages and rubric
  judgments for each case.

How goals are checked (ADR 0069). Every owner message gets a goal: a
template goal when the owner picks one, otherwise the CEO drafts the objective,
definition of done and checks with `set_goal` before any other work, and the
host locks them. Work finishes only through `submit_work`, which hands in a
summary and the files made (paths relative to the company root, such as
`drive/goals/<goalId>/deliverables/brief.md`, or to the agent's own home). A
hand-in naming a file that does not exist is refused on the spot.

A goal on the CEO's task is the company's goal, so `goals.ts` checks it
against the whole team: the trace includes every run delegated under the CEO,
and each handed-in text file is an artifact (`deliverable` for the first,
`deliverable.<ext>` and `deliverable:<name>` for the rest). Numeric checks
read only numbers the host measures (decision 11): `deliverableCount`,
`deliverableWords`, `deliverableLines`, `deliverableLinks`,
`deliverableTableRows`, `deliverableListItems` and `deliverableSections`, or a
field of a handed-in JSON file (`outputPath` with `target: "artifact:deliverable.json"`).
Checks look at results, never at which agent did the work.

Second opinions run on a model other than the worker's (decisions 10 and 12):
the rubric judge, and the reviewer that must agree a task is impossible in
principle before an agent may give up. The candidates are the company's
`judgeModels`, then each tier's model. The owner is never the judge.

The owner can change a goal at any time with `PUT /api/tasks/:id/goal`
(objective, definition of done, checks); every unfinished task under it is told
at its next step and the checks run against the new version. Agents never wait
on the owner: `ask_owner` writes a question down with the assumption the agent
is working on, listed at `GET /api/questions` and answered with
`POST /api/tasks/:id/questions/:questionId/answer`.

Evals. `npm run evals -w @generic-ai/app-generic-corp` replays every
template's suite offline: a fresh company per attempt, the recorded turns on a
scripted model, and the real cascade, tools, validators and scoring. It exits
1 when any gate fails, and CI runs it after the build. Add `--live` to run on
the real models with a model judge (needs provider keys; this is what the
reliability gate runs), `--template <id>` to pick one, `--trials <n>` and
`--out <dir>` for reports. A replay that drifts from the recorded path (an
agent asks for a turn the recording does not have) fails the attempt.

Reliability gate (R19). The same suites with `--live`, failing when any gate
fails. It is manual only. Run it on your own machine with the key in your environment, so the key
never has to go to GitHub:

```bash
export ANTHROPIC_API_KEY=...        # required
export BRAVE_API_KEY=...            # optional (or TAVILY_API_KEY); research goals need one
npm run reliability -w @generic-ai/app-generic-corp              # quick run
npm run reliability -w @generic-ai/app-generic-corp -- --full    # the real gate
npm run reliability -w @generic-ai/app-generic-corp -- --docker  # inside the production image
```

| Mode | Models | Attempts | Cap | Estimated cost |
| --- | --- | --- | --- | --- |
| quick (default) | CEO on Sonnet 5.5, VPs and ICs on Haiku 5.5, judge on each template's VP model | 1 per goal | $5, 5M tokens | about $1 to $3 |
| `--full` | each template's own models (Opus 5.5 CEO, Sonnet 5.5 VPs) | each suite's count, 5 | $50, 40M tokens | about $25 to $50 |

Quick mode says whether the cascade, tools and validators work on real models;
pass^k needs `--full`. `--template <id>`, `--trials <n>`, `--max-usd <n>` and
`--max-tokens <n>` override either mode, and `--model ceo=<ref>` pins one tier
(the eval CLI also takes `--economy` directly). Reports, including
`summary.json` with the verdict and spend, go to `./reliability-report`. The
script exits 0 when every gate passed, 1 when one failed, and 3 before
spending anything when no key is set. The estimates are not measured yet: a
full attempt was expected at $1 to $2 at list prices, mostly Sonnet turns with
prompt caching, and quick mode moves most turns to Haiku, which lists at a
twentieth of Sonnet's price.

Caps: the whole run stops at its dollar and token cap. Each agent turn starts
with what is left of the cap as its harness budget, so the turn in flight stops
with `budget_exceeded`; rubric judgments count against the cap too; attempts
that would start after it are not run and count as failures.

There is no Actions workflow for this on purpose: automated runs never call a
real model, so the reliability gate only runs when you start it by hand, and the
provider key stays on your machine.

To add a template, copy a folder, change `company.yaml`, and record a replay
for each goal. `templates.test.ts` checks that every goal has a case, a replay,
and numeric, rubric and trace validators.

## End-to-end, crash and load tests

`e2e/` holds Playwright tests that start a real server (dashboard, API, cascade,
permissions gate, durable queue) on a scripted model, so no key is needed and
nothing is spent. CI runs them in the `e2e` job of the Quality Gate workflow when the app or
packages change.

```bash
npm run build
npm exec -w @generic-ai/app-generic-corp -- playwright install chromium  # once
npm run e2e -w @generic-ai/app-generic-corp
```

- `golden-flows.spec.ts`: chat with the CEO, delegation to a VP (board and org
  chart), and an email refused because sending is off, shown on the
  refused-actions list, then sent exactly once after the owner turns sending on.
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
