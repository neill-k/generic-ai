# @generic-ai/preset-starter-hono

The default Generic AI starter preset. It composes the local-first working stack and is the path `createGenericAI()` loads when callers do not supply a custom composition.

Planned preset behavior (see `docs/planning/02-architecture.md` section "Starter Preset"):

- Wires a local-first development stack
- Uses SQLite for durable storage and the in-process queue for async runs
- Ships standard terminal tools, file tools, MCP, Agent Skills, delegation, messaging, and file-backed memory
- Includes Hono by default so the starter works without additional transport assembly
- Exposes a simple programmatic bootstrap path and is exercised by the reference example in `examples/starter-hono/`

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
