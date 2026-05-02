# 0040 MCP Trust Benchmark Profile

## Context

MCP turns tools into discoverable, composable runtime objects with
natural-language metadata, schema declarations, transports, and external
authorization behavior. That makes MCP useful for interoperability, but it also
creates benchmarkable attack surfaces: poisoned tool descriptions, indirect
prompt injection in tool output, schema deception, unexpected side effects, name
collisions, and privilege escalation.

Linear NEI-493 asks for an MCP trust and attack benchmark profile. Generic AI
already has SDK benchmark profiles for fault injection, tool-use discipline,
contextual-integrity privacy, policy decisions, and capability effects. The
missing contract is MCP-specific enough to preserve trust level, transport,
tool authority, expected outcome, and observed unsafe execution without moving
MCP policy into the kernel.

## Decision

Add MCP trust as an optional SDK benchmark profile and report summary.

The SDK owns the reusable evidence contract:

- MCP server trust levels: local, workspace, remote-authenticated,
  remote-untrusted, and generated.
- MCP attack classes: tool poisoning, indirect prompt injection, schema
  deception, unexpected side effects, privilege escalation, name collision,
  mixed, and custom.
- Planned MCP trust cases with expected outcomes: blocked, warned, allowed, or
  insufficient evidence.
- Trial observations with observed outcome, unsafe-call flags,
  unsafe-execution flags, warnings, policy decision references, and evidence
  references.
- Report summaries for blocked, warned, allowed, insufficient-evidence,
  unsafe-call, unsafe-execution, warning, and resilience counts.

For v0.1 this is a benchmark grader/report surface. `@generic-ai/plugin-mcp`
and future policy packages can supply live enforcement and richer metadata, but
the kernel remains MCP-policy agnostic.

## Consequences

- Benchmark fixtures can compare MCP-aware harnesses against naive MCP users
  while keeping final task utility separate from trust evidence.
- Reports can show whether attacks were blocked, warned, allowed, or left as
  insufficient evidence, and whether unsafe tool execution occurred.
- MCP trust vocabulary is shared by benchmark examples and future policy
  plugins without requiring a dedicated MCP security platform in this slice.
- The contract is additive and optional, so existing BenchmarkSpec consumers
  continue to work.

## Alternatives Considered

### Implement MCP trust directly in `@generic-ai/plugin-mcp`

Rejected for this slice. The plugin should eventually expose server and tool
metadata, but the benchmark/report contract is useful before live enforcement
exists and must also support simulated or external adapters.

### Treat MCP trust as only fault injection

Rejected. Fault injection can model degraded boundaries, but MCP trust needs a
server/tool vocabulary, trust levels, expected outcomes, and unsafe-execution
accounting that are clearer as their own optional profile.

### Put MCP trust policy in core

Rejected. The kernel owns the harness control plane and report pipeline, not
transport-specific MCP security policy.
