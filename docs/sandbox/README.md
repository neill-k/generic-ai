# Sandbox Execution Docs

This doc pack covers the public sandbox contract in `@generic-ai/sdk`, the
Docker-backed implementation in
`@generic-ai/plugin-tools-terminal-sandbox`, and the starter-preset migration
path that replaces unrestricted host terminal execution with sandbox execution.

## Read This First

- [`plugin-api-reference.md`](plugin-api-reference.md) for the public contract,
  config schema, and exported helpers
- [`operator-guide.md`](operator-guide.md) for prerequisites, enablement,
  verification, and troubleshooting
- [`migration-guide.md`](migration-guide.md) for the step-by-step move from
  `@generic-ai/plugin-tools-terminal` to the sandbox plugin
- [`security-model.md`](security-model.md) for the protection model,
  limitations, and deployment posture
- [`../decisions/0013-sandboxed-execution.md`](../decisions/0013-sandboxed-execution.md)
  for the repo-level decision and trade-offs

## Scope

These docs describe the shipped sandbox surface:

- runtimes: `bash`, `node`, and `python`
- policy families: resources, network, and file I/O
- session lifecycle: `createSession()`, `exec()`, `destroy()`, and one-shot
  `run()`
- result fields: separate `stdout` / `stderr`, truncation flags, resource usage,
  artifact metadata, host `cwd`, and sandbox `sandboxCwd`
- starter-preset migration through an explicit `terminalTools` slot override

The current starter-preset integration is programmatic. Callers opt into the
sandbox by overriding the `terminalTools` slot to
`@generic-ai/plugin-tools-terminal-sandbox`. If later bootstrap helpers add
environment-variable selection on top, they should layer on the same contract
described here rather than replacing it.
