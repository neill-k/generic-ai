# @generic-ai/plugin-approvals

Owner approvals for outward or costly actions. When an agent tries to send a
message, write to an external system, spend money, or call a writing MCP tool,
the call waits for the owner instead of running. The owner approves or rejects
it from an inbox, the decision records who made it, and the agent's work
continues on its own.

Decision record: `docs/decisions/0061-owner-approvals-for-outward-actions.md`.

## Pieces

- `createApprovalService({ runStore })`: durable approval requests on the SDK
  run store (SQLite or Postgres). Requests are decided once, claimed for
  execution once, expire after 72 hours by default, and keep an `approval.*`
  event log as their audit trail.
- `createApprovalGate({ service, requester, policy, mode })`: wraps agent
  tools (`wrapTool`) or a whole capability bindings object (`wrapBindings`,
  covering terminal, file, custom and MCP tools). The policy is the SDK
  `ApprovalPolicy`; `DEFAULT_APPROVAL_POLICY` gates `message.send`,
  `external.write`, `payment.spend` and `mcp.write`.
- `createApprovalRoutes(service, { authenticate })`: the owner's approval
  inbox over Hono, with an SSE stream for live views.
- `createTopologyApprover({ service, requester })`: plugs into the topology
  runner's `approve` hook.
- `interceptToolExecute(tool, handler)` and `wrapToolBindings(bindings, wrap)`:
  the wrapping the gate uses, for other per-call checks. Generic Corp's
  permission gate (refuse on the spot, never wait) is built on them.

## With the delegation cascade

```ts
import { createApprovalGate, createApprovalService, approvalRequesterForTask } from "@generic-ai/plugin-approvals";
import { createAdapterTaskExecutor, createDelegationCascade } from "@generic-ai/plugin-delegation";

const approvals = createApprovalService({ runStore });
const executor = createAdapterTaskExecutor({
  adapter,
  harness,
  context,
  capabilities: (input) =>
    createApprovalGate({ service: approvals, requester: approvalRequesterForTask(input) })
      .wrapBindings(baseCapabilities),
});
const cascade = createDelegationCascade({ runStore, queue, directory, executor, approvals });

app.route(
  "/",
  createApprovalRoutes(approvals, {
    authenticate: (request) => authenticateOwnerRequest(ownerAuth, request),
    onDecided: (approval) => cascade.approvalDecided(approval.approvalId),
  }),
);
```

A gated call returns a tool result telling the agent to end its turn. The
cascade parks the task as `waiting` without holding a worker, and resumes it
when every request is decided. An approved action runs when the agent repeats
the identical call, at most once.

For a single interactive run, use `mode: "wait"` so the call blocks until the
owner decides (10 minutes by default).

## HTTP API

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/approvals?status=pending&taskId=&rootTaskId=&agentId=&limit=` | `runs:read` |
| GET | `/approvals/stream` (server-sent events) | `runs:read` |
| GET | `/approvals/:id` (request plus audit `events`) | `runs:read` |
| POST | `/approvals/:id/approve` `{ "comment"?: string }` | `approvals:decide` |
| POST | `/approvals/:id/reject` `{ "comment"?: string }` | `approvals:decide` |
