# 0014. Runtime Governance And Security Controls

Status: accepted

> Originally drafted as 0013 during NEI-347; renumbered to 0014 to avoid collision with `0013-sandboxed-code-execution.md` (NEI-371).

## Context

Generic AI's current v1 posture intentionally favors local usability:

- `@generic-ai/plugin-tools-terminal` executes host-local commands and marks the
  result `unrestrictedLocal`.
- `@generic-ai/plugin-tools-files` enforces workspace-root containment, but it
  does not yet model per-operation approvals or scoped write classes.
- `@generic-ai/plugin-mcp` validates server launch metadata, but it does not yet
  model trust tiers, approval flows, or transport-specific governance.

That is acceptable for local development, but it is not the right production
default. The deferred `DEF-04` track needs a concrete plan so future work does
not have to rediscover where policy belongs or how the terminal, file, and MCP
surfaces should be hardened consistently.

The relevant external guidance points in the same direction:

- Node's child-process docs warn that unsanitized shell input can trigger
  arbitrary command execution.
- Node's permission model is explicitly a seat belt rather than a security
  boundary.
- Docker's container security guidance emphasizes least privilege, read-only
  mounts where possible, and keeping the default seccomp profile in place.
- The MCP spec recommends human approval for sensitive tool and sampling
  actions, requires access-control and audit consideration for tools, and
  requires strict token handling for HTTP authorization flows.

## Decision

Runtime governance remains plugin-owned at enforcement time.

- Terminal, file, and MCP plugins each make the final allow/deny decision for
  their own operations.
- A future shared policy abstraction lives in `@generic-ai/sdk`, not in the
  kernel. The contract should express subject/session metadata, capability,
  operation, target resource, risk tier, approval requirement, and audit
  payload.
- The kernel remains policy-agnostic. It continues to provide scope/session
  context and audit-friendly lifecycle events, but it does not own
  capability-specific access rules.
- Production presets should default toward least privilege: sandboxed terminal
  execution, explicit file scopes, and explicit MCP trust/approval rules.
- Sensitive operations should default to human approval where the hosting
  surface can provide it.
- The concrete roadmap for this deferred track is recorded in
  `docs/runtime-governance.md`.

## Consequences

- The established package boundaries stay intact: capability plugins remain
  replaceable, and the kernel does not become a policy engine.
- Future governance work has one shared contract vocabulary instead of ad hoc
  policy logic in each capability package.
- Policy work will be spread across multiple packages when implemented, because
  each capability still owns its own enforcement logic.
- Presets and operator-facing configuration become the place where permissive
  local profiles and restrictive hosted profiles diverge.

## Alternatives considered

### Make the kernel own all policy decisions

Rejected because it would blur the existing kernel/plugin boundary and make
terminal, file, and MCP plugins less replaceable. It would also centralize
business rules that are inherently capability-specific.

### Let each plugin invent its own policy API

Rejected because it would fragment configuration, approvals, and audit output.
The framework would likely end up with three incompatible policy systems.

### Leave the deferred track undocumented until a hosted product exists

Rejected because the architecture question would have to be reopened later, and
the current permissive local defaults would remain under-specified in the
meantime.
