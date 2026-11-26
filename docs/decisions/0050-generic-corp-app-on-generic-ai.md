# 0050: Generic Corp Is The Flagship App Built On Generic AI

- Status: accepted
- Date: 2026-11-26
- Supersedes: the "Core Product Decision" in
  [`docs/planning/01-scope-and-decisions.md`](../planning/01-scope-and-decisions.md)
  that Generic AI is "not a reimplementation of the full Generic Corp product".
- Numbered 0050 to stay clear of records being added in parallel (0042 is used
  twice by open work on the topology runner and the durable run store).

## Context

Generic AI started as a composable agents-as-code research harness. Its
planning pack said the harness "is not a reimplementation of the full Generic
Corp product" and named Architecture Lab as the flagship demo.

Generic Corp is the owner's "AI company" product, defined in the archived
private repository `neill-k/generic-corp`: a person chats with a CEO agent,
agents sit in an org chart (CEO, VPs, individual contributors), work is
delegated down and results come back up, and a dashboard shows chat, the org
chart, a board, agent activity, costs and approvals. That repository was
archived because it had become unwieldy: multi-tenancy, an agent economy,
federation and other scope grew faster than the core loop matured.

The owner has now set a different goal for this repository: help people build
complex multi-agent systems that pursue a goal, without today's complexity.
The design brief for that goal is the owner's paper *Building Production
Agents: The NOVA Framework*, whose promise is an agent that is "reliable and
repeatable while reducing token consumption by 90%". It rests on two
principles and four steps:

- Mirror how the model was trained: give it a goal and a way to check the goal
  is met, and stay "in distribution".
- "Offload as much work as possible out of the model", to files and to code.
- The steps: set a defined goal ("What is the definition of done? Is there
  some condition that can be tested to determine that the work is
  complete?"), offload to files and code, validate results, and run evals.
- "Start as simply as possible and add complexity to address issues you find
  in the Evaluation process", and "If the entire process is deterministic and
  needs to be exact same every time, you should just write a program to do
  it."

Six product decisions (D1 to D6) were put to the owner on 2026-11-26 and
answered the same day.

## Decision

Generic AI is the framework. Generic Corp is the flagship production app built
on it, and it lives in this monorepo.

The owner's answers, recorded as decided:

| # | Question | Decision |
| --- | --- | --- |
| D1 | Is the `neill-k/generic-corp` product the right Generic Corp? | Yes. Generic AI is the framework and Generic Corp is an app on it. |
| D2 | Where does the app live? | Inside this monorepo, at `apps/generic-corp`. |
| D3 | Which models, and whose keys? | Add Anthropic alongside the existing OpenAI path, and choose the model per role in config. |
| D4 | Who uses it in production? | A single owner self-hosting, for v1. No tenants. |
| D5 | Where does it run? | Railway in production, Docker for local testing. |
| D6 | What work do the agents do? | Generic work, not only software in git repositories: "that's where the 'generic' in 'generic-ai' lives." |

The owner also set the runtime direction: Generic AI becomes a full harness of
its own, with feature parity against `pi` and PrimeIntellect's Prime Agent,
verified with their automated tests. That workstream is tracked in
[`docs/planning/native-harness-parity.md`](../planning/native-harness-parity.md).

Generic Corp v1 is: one owner runs a company of persistent agents that can
pursue any goal. The owner chats with the CEO; work flows through the org
chart by durable delegation; every task carries a definition of done and
validators; agents keep their own memory and workspaces and reach the outside
world through tools and MCP connectors; outward or risky actions wait for the
owner's approval; every run is traced and costed; and a dashboard shows chat,
org chart, board, agent activity, costs and approvals. Agent economy,
federation, multi-tenant billing and voice are out of v1.

Layering rules that keep the framework generic:

- `apps/*` workspaces are applications. They compose presets and plugins and
  may depend on any `@generic-ai/*` package. No package under `packages/` may
  depend on an app.
- Generic Corp concepts (CEO, org chart, board, company templates) stay in
  `apps/generic-corp` unless a later ADR promotes a general form of them into
  the SDK or a plugin. The test for promotion is whether another multi-agent
  app would need the same contract.
- Framework work that Generic Corp needs (goals and validators, durable
  delegation, approvals, cost accounting, auth) lands as framework contracts
  and plugins first, with the app as their first consumer.
- The research-harness surfaces (Harness DSL, benchmarks, evidence reports)
  stay. They become the evaluation layer for apps built on the framework, in
  line with NOVA's evals step.

## Consequences

- The README and the planning pack describe Generic AI as a framework for
  building goal-driven multi-agent systems, with Generic Corp as the flagship
  app and the research harness as its evaluation layer.
- The monorepo gains an `apps/*` workspace group. `apps/generic-corp` starts
  as an empty workspace wired to the starter preset, and later work fills it
  in.
- Because the app ships from the same repository, publishing `@generic-ai/*`
  to npm is no longer a prerequisite for the app.
- Production needs follow from D3 to D6: an Anthropic provider and per-role
  model config, a durable store that runs on Postgres for Railway, a Docker
  image for local testing, single-owner auth without tenant columns, and
  approvals that cover outward actions such as sending email, not only shell
  commands.
- Architecture Lab remains a valid demo of the research-harness surface but is
  no longer the flagship.

## Alternatives Considered

### Keep Generic AI a research harness only

Rejected by the owner (D1). The research surfaces are useful, but on their own
they do not meet the goal of helping people build production multi-agent
systems.

### Build Generic Corp in its own repository on published packages

Rejected (D2). Framework and app changes would ship separately, and the app
would wait on npm releases of every framework package. Keeping the app in the
monorepo lets a framework change and its first consumer land in one pull
request.

### Software work only for v1

Rejected (D6). The old Generic Corp only did software work in git
repositories. The owner wants agents that do generic work, so tools, approvals
and company templates must cover work such as research, documents and
communication from the start.

### Multi-tenant SaaS for v1

Deferred (D4). Tenant isolation, billing and signup would roughly double the
durable-runtime phase, and a single owner self-hosting is enough to prove the
product.
