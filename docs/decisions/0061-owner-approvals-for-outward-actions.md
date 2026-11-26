# 0061 — Owner approvals for outward actions

- Status: accepted
- Date: 2026-11-26
- Roadmap item: R11 (approvals and governance runtime) of the Generic Corp
  production roadmap.
- Related: `0014-runtime-governance-and-security-controls.md`,
  `0024-capability-effect-descriptors.md`, `0034-reversibility-effect-descriptors.md`,
  `0043-durable-run-store-and-queue.md`, `0044-persistent-agents-and-delegation-cascade.md`,
  `0045-owner-auth-identity.md`

## Context

Generic Corp agents do generic work, not only software. They send email,
post to chat, create calendar events, change records in other systems, and may
spend money. Those actions leave the company and usually cannot be taken back,
so the owner must sign off on them. Before this change the harness could only
allow or deny a tool by role (the effect policies in core), the topology runner
had an in-memory `approve` hook, and nothing paused durable work for a human.

Agent turns run on the durable queue and are at-least-once (ADR 0044). An
outward action must therefore never run twice because a turn was retried, and
a task that waits for the owner, possibly for days, must not hold a worker.

## Decision

1. **Policy over effects, in the SDK.** `ApprovalPolicy` is an ordered list of
   rules matched on a tool's effect descriptors, tool name patterns, agent ids,
   roles, and reversibility; the first match decides `allow`, `deny`, or
   `require_approval`. `DEFAULT_APPROVAL_POLICY` requires approval for any tool
   with an outward effect (`message.send`, `external.write`, `payment.spend`,
   `mcp.write`) and allows everything else. Tool plugins classify their own tools;
   the policy never inspects arguments. `parseApprovalPolicy` validates policies
   from config.
2. **Durable requests on the run store.** `@generic-ai/plugin-approvals` stores
   each request as a run-store record under the `approvals` scope, so it works on
   SQLite and Postgres without new tables. A request carries the requester
   (agent, role, task, run, and the run's actor), the exact action (tool name,
   input, a SHA-256 digest of name plus canonical JSON input, effects,
   reversibility, a one-line summary), the matching rule, and an expiry
   (72 hours by default). Optimistic versioning makes `decide` and
   `claimExecution` safe under concurrent callers.
3. **Decisions record who made them.** `decide` takes a `RunActor` (from the
   owner's `AuthContext`, ADR 0045) and an optional comment. A new
   `approvals:decide` scope gates it; the owner holds every scope.
4. **Audit trail as canonical events.** A new `approval` event family
   (`approval.requested`, `.approved`, `.rejected`, `.denied`, `.expired`,
   `.cancelled`, `.executed`, `.execution.failed`) is written to each request's
   event log, with the deciding actor on the event. Policy denials are stored
   as `denied` requests so refusals are auditable too. The delegation cascade
   also logs `approval.requested` on the waiting task.
5. **A gate wraps tools, not runtimes.** `createApprovalGate().wrapBindings()`
   wraps terminal, file, custom and MCP tools in a capability bindings object
   before it reaches the harness adapter, so it works the same on Pi and on the
   native runtime, which both execute the same tool definitions.
6. **Suspend, do not block, in the cascade.** In `suspend` mode a gated call
   creates the request and returns a tool result telling the agent to end its
   turn. When the turn ends with pending requests for its task, the cascade
   moves the task to `waiting` (as it does for delegated children), releases
   the worker, and resumes the task once every request is decided, expired or
   cancelled. The next prompt shows each decision; an approved action shows its
   exact input so the agent repeats the call. `approvalDecided()` resumes at
   once after an in-process decision; started workers poll every 5 seconds for
   decisions made elsewhere, and `recover()` handles restarts. Cancelling a
   task cancels its open requests. `wait` mode blocks the call instead, for
   single interactive runs and the topology runner's `approve` hook.
7. **Approved means the same action, once.** A gated call matches a request
   by task and digest, so only the identical call runs. The gate claims the
   request before running the tool; a second claim fails. If the process dies
   between the claim and the result, the action is not repeated automatically
   (at most once): the agent is told it may have run and must ask again. A
   second identical action, or any different input, needs a new approval.
8. **HTTP inbox for the dashboard.** `createApprovalRoutes` serves list, detail
   with audit events, approve, reject, and an SSE stream of changes. It takes
   an `authenticate` function (normally `authenticateOwnerRequest` from the auth
   plugin) and refuses to start without one unless explicitly local.

## Consequences

- Agents can work on outward tasks without the owner watching every turn; the
  owner decides from an inbox and the work continues on its own.
- The policy is only as good as tool classification. Tools without the new
  effects (for example an MCP server whose tools are all tagged `mcp.write`)
  fall back to coarser rules; the generic-work toolkit (R23) tags its
  connectors with `message.send` and `external.write`.
- Approval relies on the agent repeating the call. A different input, by
  design, needs a fresh approval rather than running something the owner did
  not see.
- Request inputs are stored up to 64 KiB so the owner sees exactly what will
  run. Secrets must stay out of tool inputs (R12 resolves placeholders at call
  time).
- The poller scans waiting tasks; this is fine for one company's volume and
  can move to a dedicated index if it becomes slow.

## Alternatives considered

- Run the approved action from the stored input without the agent. Rejected
  for now: tools are bound per turn inside the runtime, so the harness cannot
  call them outside a turn without a second tool registry.
- Block the turn until the owner decides. Rejected for the cascade: it holds a
  worker and a model session for hours and does not survive restarts. Kept as
  the `wait` mode for interactive runs.
- A separate approvals table. Rejected: the run store already gives both
  backends, versioning and an event log.
