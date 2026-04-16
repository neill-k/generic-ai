# Runtime Governance And Security Controls

## Why

Generic AI intentionally shipped v1 with a local-first posture so the starter
preset could be used immediately:

- `@generic-ai/plugin-tools-terminal` runs host-local commands and reports that
  posture via `unrestrictedLocal`.
- `@generic-ai/plugin-tools-files` keeps callers inside the workspace root, but
  otherwise exposes broad read/write/edit/list behavior.
- `@generic-ai/plugin-mcp` validates launch metadata, but it does not yet model
  server trust, approval flows, or per-tool restrictions.

That posture is acceptable for local development, but not for hosted,
multi-tenant, or policy-sensitive deployments. `DEF-04` exists to make the
deferred hardening track concrete enough to resume later without reopening the
architecture question.

## Current posture

- Terminal execution already has control points for `cwd`, env overrides,
  command prefixing, timeouts, and execution-mode metadata. The sandbox backend
  from the sandbox epic exists, but it is not yet the default terminal posture.
- File tools already enforce workspace-root containment and skip symlink
  traversal during recursive walks, but they do not yet model per-operation
  scopes, protected paths, write quotas, or user approval.
- MCP already has a registry, launch resolution, roots metadata, and server
  descriptions, but it does not yet model trust tiers, token-handling policy,
  or per-server/per-tool approvals.
- `@generic-ai/plugin-tools-web` already enforces host allow/block rules. That
  is the clearest existing precedent for a future shared policy vocabulary, but
  it should not become the policy engine for other capabilities.

## Decision summary

- Enforcement stays plugin-owned. Terminal, file, and MCP plugins each make
  their final allow/deny decision at execution time.
- A future shared abstraction belongs in `@generic-ai/sdk`, not in the kernel.
  The SDK contract should carry the policy input and output shape:
  subject/session metadata, requested capability + operation, target resource,
  risk tier, approval requirement, and audit payload.
- The kernel remains policy-agnostic. It should propagate scope/session context
  and emit audit-friendly lifecycle events, but it should not own the business
  rules for terminal, file, or MCP access.
- Sensitive operations should default to human approval where possible. MCP's
  tool and sampling guidance already assumes a human can deny sensitive actions,
  and Generic AI should mirror that posture for high-risk local capabilities.
- Production presets should default toward least privilege: sandboxed command
  execution, explicit file scopes, and explicit MCP trust/approval rules.
  Faster permissive local presets are still allowed, but only by deliberate
  configuration.
- Policy decisions, approvals, denials, and redactions should be audit-visible
  through the existing event-stream and OTEL/logging surfaces.

## Control surfaces

| Capability | Current anchors | Resume with |
| --- | --- | --- |
| Terminal | `packages/plugin-tools-terminal/src/index.ts`, sandbox backend stack, starter preset terminal slot | Execution profile selection (`local` vs `sandbox`), env allow/block lists, command risk tiers, approval gates for destructive or external-network operations, resource + time budgets, redacted audit output |
| Files | `packages/plugin-tools-files/src/index.ts`, `@generic-ai/plugin-workspace-fs` safe resolvers | Read/write/delete scopes, protected-path classes, size quotas, destructive-write approvals, secret/binary safeguards, audit records for mutating operations |
| MCP | `packages/plugin-mcp/src/index.ts`, runtime `mcp_registry` tool | Server manifests with trust tier, transport allowlists, roots/env restrictions, OAuth/token hygiene for HTTP transports, per-server/per-tool approval, usage rate limits, audit + rotation guidance |
| Cross-cutting runtime | kernel scope/session metadata, event stream, preset/config surfaces, `@generic-ai/plugin-logging-otel` | Shared SDK policy contract, reusable policy profiles, approval-service integration point, consistent audit schema, operator-visible review trail |

### Terminal hardening path

The terminal track should resume with these defaults:

1. Host-local execution is a development profile, not the production default.
2. Sandbox-backed execution is the default production path, with explicit
   operator opt-in required to re-enable host-local command execution.
3. Every request carries a risk classification derived from:
   command shape, cwd target, env exposure, network posture, and mutating intent.
4. High-risk requests require approval before execution and emit an audit event
   regardless of allow/deny outcome.
5. Env forwarding is opt-in and deny-by-default for secrets not explicitly
   exposed to the tool call.

### File hardening path

The file track should resume with these defaults:

1. Preserve workspace-root containment as the non-negotiable base guard.
2. Add path scopes on top of containment: read-only, writable, protected, and
   denied classes.
3. Treat mutating operations (`write`, `edit`, delete when added later) as
   higher-risk than `read`, `find`, `grep`, and `list`.
4. Keep symlink and path-normalization rules explicit in policy docs because
   Node's process permission model is only a seat belt, not a security boundary.
5. Emit audit records for mutating operations with redaction support for file
   contents and sensitive path segments.

### MCP hardening path

The MCP track should resume with these defaults:

1. Treat every configured server as an explicit trust decision, never an
   implicit extension of the host runtime.
2. Split policy between server-registration controls and tool-invocation
   controls.
3. For HTTP transports, require proper OAuth/OIDC-style token handling and
   forbid token passthrough to downstream services.
4. For stdio transports, require explicit env and cwd policy because the MCP
   authorization spec does not apply there.
5. Require approval and audit hooks for high-risk servers or tools, especially
   those with write, network, shell, or secret-access behavior.

## Resume order

When this deferred track is resumed, split it into the following slices:

1. **SDK and config contract**
   - Add a shared capability-policy contract to `@generic-ai/sdk`.
   - Add config-schema fragments for policy profiles and approval strategies.
   - Extend runtime/event docs so policy decisions have a stable audit shape.
2. **Capability integrations**
   - Terminal: local vs sandbox profile selection, env policy, approval gates,
     and audit output.
   - Files: scoped path classes, protected locations, mutating-operation policy,
     and audit output.
   - MCP: server manifest trust tiers, transport-specific policy, approval
     points, and token-handling constraints.
3. **Preset and operator surfaces**
   - Ship at least two preset profiles: local development and hosted/production.
   - Document the approval UX expectations for transports or control planes that
     surface high-risk operations to users or operators.
   - Wire policy outcomes into OTEL/logging exports so denials and overrides are
     reviewable after the fact.

## Exit criteria for the future implementation track

The governance/runtime security track is ready to close only when:

- one shared config surface can express allow / deny / ask semantics for the
  terminal, file, and MCP capabilities;
- a production preset never exposes host-local terminal or broad file access
  without explicit opt-in;
- MCP trust and token-handling rules are explicit for both stdio and HTTP
  transports;
- audit events capture subject, target, requested operation, decision, and
  reason in a transport-independent shape.

## Source anchors

The roadmap above is grounded in the official guidance below:

- [Node.js child process docs](https://nodejs.org/api/child_process.html)
- [Node.js permission model docs](https://nodejs.org/api/permissions.html)
- [Docker bind mounts docs](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker seccomp docs](https://docs.docker.com/engine/security/seccomp/)
- [Docker container security FAQ](https://docs.docker.com/security/faqs/containers/)
- [MCP tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP sampling spec](https://modelcontextprotocol.io/specification/draft/client/sampling)
- [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
