# @generic-ai/plugin-tools-terminal-sandbox

Docker-backed sandbox terminal execution for Generic AI agents.

## What this package does

- creates one container per sandbox session
- executes commands inside that container instead of on the host
- captures structured `stdout`, `stderr`, exit codes, wall-clock timing, resource usage, and produced artifacts
- preserves terminal-compatible fields like `output`, `timedOut`, and `unrestrictedLocal: false` while adding sandbox-specific `image`, `sandboxCwd`, artifact, `generatedFiles`, and truncation metadata
- stages a workspace snapshot for read-only mounts and supports writable copy-mode staging for explicit file lists
- enforces Docker CPU and memory ceilings plus Docker-stop timeout escalation
- degrades cleanly when the Docker daemon is unavailable

This package is the production-oriented counterpart to
[`@generic-ai/plugin-tools-terminal`](../plugin-tools-terminal/README.md), which
remains the explicit unrestricted local-development path.

## Current defaults

- backend: Docker CLI / Docker daemon
- Node image: `node:24-bookworm-slim`
- Python image: `python:3.12-slim`
- default resource ceilings: `1` CPU, `512MiB` memory, `30s` timeout, `5s` timeout grace, `100MiB` writable output
- optional output cap: `policy.resources.maxOutputBytes` truncates `stdout` and `stderr` independently and marks the result when either stream is clipped
- default network policy: `isolated`
- default file policy: read-only workspace mount plus `workspace/shared/sandbox-results`
- default staged-workspace cap: `policy.files.maxInputBytes = 268435456` (256 MiB)
- readonly snapshots skip top-level `.git/` and `node_modules/` directories before mounting

## Network modes

- `isolated`: starts the sandbox with `--network none`
- `open`: uses Docker bridge networking directly
- `allowlist`: puts the sandbox on a Docker `--internal` network and injects HTTP(S) proxy env vars that route outbound traffic through a sidecar allowlist proxy

Allowlist entries accept exact hosts (`example.com`), host/port pairs
(`registry.npmjs.org:443`), and wildcard subdomains (`*.example.dev`).
Blocked outbound targets are appended to sandbox stderr with destination info.

## Runtime expectations

- Docker CLI must be installed on the host
- Docker Desktop / daemon must be reachable for real sandbox execution
- writable sandbox output is constrained inside the container and copied back to the host output directory after execution
- copy mode stages only `policy.files.copyInPaths` into `/workspace` and mirrors `policy.files.copyOutPaths` back into the host output directory
- allowlist mode currently governs outbound HTTP(S) flows by forcing the sandbox through the sidecar proxy; host-side `plugin-tools-web` traffic is unaffected because it runs outside the sandbox session
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
