# 0024 - Capability Effect Descriptors

## Context

Harness roles need enforceable authority boundaries. Filtering tools by name, such as hiding tools named `write` or `edit`, is not a real policy model. A custom tool, terminal command, memory writer, MCP launcher, or network tool can mutate state regardless of its display name.

Generic AI needs a composable capability model where plugins declare what their tools can do and core composes role access by effect.

## Decision

SDK tool metadata includes declared capability effects such as:

- `fs.read`
- `fs.write`
- `process.spawn`
- `network.egress`
- `mcp.read`
- `mcp.launch`
- `memory.read`
- `memory.write`
- `handoff.read`
- `handoff.write`
- `artifact.write`
- `repo.inspect`
- `lsp.read`
- `secret.read`
- `sandbox.create`

Plugins attach effect metadata to tool descriptors. Core role policy filters by declared effects, not tool names. Tools without declared effects are denied in harness roles for P1 so missing metadata fails closed.

Role policies may grant a different allowed effect subset for a capability class. P1 uses this for the verifier role: file write/edit tools remain denied, while the terminal capability is allowed as an explicit verification execution surface because real benchmark verification usually requires process execution.

`benchmark-container` also denies selected effects at binding time, including network egress, MCP launch, secret reads, and nested sandbox creation.

## Consequences

"Read-only" becomes an enforced capability subset instead of only prompt text.

Verifier terminal access is not equivalent to a fully read-only sandbox. It is an acknowledged execution grant and must be tightened later with command policy, workspace snapshot/restore, or sandboxed verification. The important P1 correction is that this authority is visible in effect metadata and policy decisions instead of being smuggled through a tool name.

Some existing tools need effect metadata before they are usable through `AgentHarness`. That is intentional for the public harness spine: capability authors must state authority before core can safely compose them.

## Alternatives Considered

### Continue name-based filtering

Rejected. Names are incidental and easy to bypass.

### Let each plugin enforce its own role policy

Rejected for the harness spine. Plugins still own local safety checks, but cross-plugin role composition belongs in core over SDK effect descriptors.
