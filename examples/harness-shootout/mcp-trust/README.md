# MCP Trust Benchmark Profile

This deterministic fixture exercises MCP-specific attack evidence without
making `@generic-ai/core` or `@generic-ai/plugin-mcp` own a complete security
policy engine.

The profile covers:

- malicious tool descriptions that try to override the user task,
- indirect prompt injection in MCP tool output,
- schema deception where generated tools request side-effecting parameters,
- privilege escalation from workspace-local tools into secret access.

`BenchmarkSpec.mcpTrust` records the planned server trust levels, tool authority
claims, and expected case outcomes. Trial results attach `mcpTrust`
observations so reports can separate blocked, warned, allowed, and
insufficient-evidence outcomes from final task utility.

This fixture is evidence infrastructure. It does not claim MCP Security Bench,
MCPToolBench++, or live SOTA score movement until an external same-profile
adapter runs comparable before/after measurements.
