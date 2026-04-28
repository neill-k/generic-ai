# @generic-ai/plugin-tools-terminal

Standard local terminal tool for Generic AI agents, packaged as a `pi` tool.

## Current posture

This package is the explicit host-execution path. It is intentionally local-first and intentionally not a sandbox:

- commands run on the host via local bash operations
- the public plugin surface defaults `unrestrictedLocal` to `true`
- command environments are minimized by default; only process-launch essentials
  such as `PATH`, `SystemRoot`, and locale variables are inherited unless
  `inheritProcessEnv: true` is set
- this is appropriate for local development and tests, not as a production isolation boundary
- the tool declares `process.spawn`, `fs.read`, `fs.write`, and
  `network.egress` effects so `AgentHarness` can withhold it from read-only or
  network-restricted roles

Sandboxed code execution is tracked separately in [`docs/decisions/0013-sandboxed-execution.md`](../../docs/decisions/0013-sandboxed-execution.md). The planned migration path is a dedicated `@generic-ai/plugin-tools-terminal-sandbox` package that can replace this package in the starter preset's `terminalTools` slot without changing kernel boundaries.

Planned responsibilities (see `docs/planning/02-architecture.md` section "Plugin Intent"):

- Ship a standard `pi` tool for local command execution
- Expose the tool to the starter preset toolbelt
- Start unrestricted for local workspace use in v1, with hardening tracked under the deferred governance track

The concrete hardening roadmap for this deferred track now lives in
[`docs/runtime-governance.md`](../../docs/runtime-governance.md).

This plugin is intentionally split from `@generic-ai/plugin-tools-files` so consumers can opt into only the surface they need.

Use `inheritProcessEnv: true` only for explicitly trusted local sessions that
need ambient credentials or other host environment variables. Prefer passing
specific `env` entries for ordinary commands.

Planning baseline:

- `docs/planning/README.md`
- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
