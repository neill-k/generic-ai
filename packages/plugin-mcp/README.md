# @generic-ai/plugin-mcp

Model Context Protocol support for Generic AI, packaged as a plugin so MCP is never a kernel hard requirement.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide embedded MCP support for the starter preset
- Remain replaceable by alternate MCP implementations
- Integrate with the session/tool surfaces exposed by `@generic-ai/sdk`
- Document its wiring path so alternate transports can coexist
- Supply MCP server/tool metadata that benchmark runs can project into
  `BenchmarkSpec.mcpTrust` cases when evaluating tool poisoning, indirect
  prompt injection, schema deception, unexpected side effects, and privilege
  escalation.

The concrete governance and approval roadmap for this deferred track now lives
in [`docs/runtime-governance.md`](../../docs/runtime-governance.md).

## MCP trust profile boundary

MCP trust evaluation is currently an SDK benchmark/report surface. The plugin
should expose enough metadata for benchmark adapters and policy packages to
record:

- server trust level: local, workspace, remote-authenticated,
  remote-untrusted, or generated;
- declared and expected tool authority;
- transport family and registration evidence;
- policy decisions for blocked, warned, allowed, or insufficient-evidence
  outcomes.

Live enforcement remains plugin/policy owned. `@generic-ai/core` must not import
MCP-specific trust classifiers, and this package should not claim external MCP
Security Bench or MCPToolBench++ score movement without a same-profile live
adapter run.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
