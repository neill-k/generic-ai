# apps/generic-corp

Generic Corp is the flagship app built on Generic AI. One owner runs a company
of persistent, goal-driven agents: the owner chats with a CEO agent, work is
delegated down an org chart and results come back up, and a dashboard shows
the conversation, the org chart, the board, agent activity, costs and
approvals. Agents do generic work, not only software work.

The decision to build it here, and the product decisions behind it, are in
[`docs/decisions/0050-generic-corp-app-on-generic-ai.md`](../../docs/decisions/0050-generic-corp-app-on-generic-ai.md).

## Status

This workspace is a scaffold. It has no product features yet.

- `createGenericCorpPreset()` composes the starter preset
  (`@generic-ai/preset-starter-hono`) with the default plugin stack and gives
  it the Generic Corp identity (`app.generic-corp`).
- It builds and runs its tests with the rest of the monorepo.

Later work adds, in roughly this order: goals and validators on every task,
persistent agents and the org chart, the durable delegation cascade, the app
server and dashboard, company templates, and the Railway deployment with a
Docker image for local testing.

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
