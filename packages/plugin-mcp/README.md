# @generic-ai/plugin-mcp

Model Context Protocol support for Generic AI, packaged as a plugin so MCP is never a kernel hard requirement.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Provide embedded MCP support for the starter preset
- Remain replaceable by alternate MCP implementations
- Integrate with the session/tool surfaces exposed by `@generic-ai/sdk`
- Document its wiring path so alternate transports can coexist

The concrete governance and approval roadmap for this deferred track now lives
in [`docs/runtime-governance.md`](../../docs/runtime-governance.md).

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
