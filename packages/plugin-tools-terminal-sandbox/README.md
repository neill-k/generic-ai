# @generic-ai/plugin-tools-terminal-sandbox

Docker-backed sandbox terminal execution for Generic AI agents.

## What this package does

- creates one container per sandbox session
- executes commands inside that container instead of on the host
- captures structured `stdout`, `stderr`, exit codes, duration, and produced artifacts
- mounts the workspace read-only and exposes a separate writable output directory
- degrades cleanly when the Docker daemon is unavailable

This package is the production-oriented counterpart to
[`@generic-ai/plugin-tools-terminal`](../plugin-tools-terminal/README.md), which
remains the explicit unrestricted local-development path.

## Current defaults

- backend: Docker CLI / Docker daemon
- Node image: `node:24-bookworm-slim`
- Python image: `python:3.12-slim`
- default network policy: `isolated`
- default file policy: read-only workspace mount plus `workspace/shared/sandbox-results`

## Runtime expectations

- Docker CLI must be installed on the host
- Docker Desktop / daemon must be reachable for real sandbox execution
- when Docker is unavailable, session creation fails with a clear
  `SandboxUnavailableError` instead of crashing the caller

## Public exports

- `createSandboxTerminalPlugin(options)` creates the runtime-backed sandbox plugin instance
- `sandboxTerminalConfigSchema` validates plugin config at registration/bootstrap time
- `sandboxTerminalPluginContract` exposes the SDK-facing plugin contract metadata
- `sandboxTerminalPluginDefinition` exposes a plugin-host-compatible manifest shape
- `createDockerCliSandboxOperations()` exposes the default Docker CLI adapter

## Verification

```bash
npm run test -- packages/plugin-tools-terminal-sandbox/test/index.test.ts
```
