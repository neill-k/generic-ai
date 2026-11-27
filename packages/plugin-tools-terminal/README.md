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
- timed-out public `run()` calls include an SDK `ToolErrorEnvelope`, and native
  backend failures are thrown as `TerminalToolError` with the same structured
  envelope for benchmark and trace consumers

## Running commands as another user, with limits

`runAs: { user }` runs every command as a separate, unprivileged OS user through
`sudo` (see `TerminalRunAsUser`). Each such command also gets resource limits,
set as both soft and hard limits so it cannot raise them:

| Limit | Default | Shell |
| --- | --- | --- |
| `memoryMiB` | 4096 MiB per process | `ulimit -d` |
| `cpuSeconds` | 3600 s per process | `ulimit -t` |
| `fileSizeMiB` | 4096 MiB per file | `ulimit -f` |
| `openFiles` | 4096 per process | `ulimit -n` |
| `maxProcesses` | 1024 for the whole user | `ulimit -u` |
| `niceness` | 10 | `nice -n` |

Core dumps are off. Set a field to `null` to leave that resource unlimited, or
`limits: false` to turn them all off. `wrapCommandForUser` and
`commandLimitScript` are exported so other shell tools apply the same wrapper.
`wrapProcessForUser` does the same for a long-lived process given as argv and
keeps its stdin (a plain command gets none), for example as the Python
workspace kernel's `launch` hook (`@generic-ai/rlm`).

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
