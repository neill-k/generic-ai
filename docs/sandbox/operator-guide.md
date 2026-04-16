# Sandbox Operator Guide

Use this guide when you need to enable, verify, or troubleshoot
`@generic-ai/plugin-tools-terminal-sandbox`.

## Prerequisites

- Docker CLI installed on the host
- Docker Desktop or another reachable Docker daemon
- a workspace root that the plugin can mount or stage
- `@generic-ai/plugin-tools-terminal-sandbox` available in the runtime
  composition
- `@generic-ai/plugin-workspace-fs` available, because the sandbox plugin
  depends on it for safe workspace resolution

Quick host checks:

```bash
docker info
npm run test -- packages/plugin-tools-terminal-sandbox/test/index.test.ts
```

The sandbox test suite contains both fake-Docker coverage and live-Docker cases.
When Docker is unavailable, the live cases skip explicitly rather than failing
the whole suite.

## Enable The Sandbox

### Direct Plugin Usage

Use this when you own the runtime composition directly:

```ts
import { createSandboxTerminalPlugin } from "@generic-ai/plugin-tools-terminal-sandbox";

const terminal = createSandboxTerminalPlugin({
  root: process.cwd(),
  config: {
    defaultRuntime: "node",
    defaultPolicy: {
      resources: {
        cpuCores: 1,
        memoryMb: 512,
        diskMb: 100,
        timeoutMs: 30_000,
        timeoutGraceMs: 5_000,
      },
      network: { mode: "isolated" },
      files: {
        mode: "readonly-mount",
        outputDir: "workspace/shared/sandbox-results",
      },
    },
  },
});
```

### Starter Preset Override

The starter preset already exposes a `terminalTools` slot. Swap that slot to
the sandbox plugin during bootstrap:

```ts
import { createStarterHonoBootstrapFromYaml } from "@generic-ai/preset-starter-hono";

const bootstrap = await createStarterHonoBootstrapFromYaml({
  startDir: process.cwd(),
  slotOverrides: [
    {
      slot: "terminalTools",
      pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
      description: "Docker-backed sandbox terminal execution.",
    },
  ],
});
```

This migration path is covered by the starter-preset unit tests in
`packages/preset-starter-hono/src/index.test.ts`.

### Canonical YAML Plugin Config

Store sandbox defaults in `.generic-ai/plugins/tools-terminal-sandbox.yaml`:

```yaml
plugin: "@generic-ai/plugin-tools-terminal-sandbox"
defaultRuntime: node
ensureImages: true
defaultPolicy:
  resources:
    cpuCores: 1
    memoryMb: 512
    diskMb: 100
    timeoutMs: 30000
    timeoutGraceMs: 5000
  network:
    mode: isolated
  files:
    mode: readonly-mount
    outputDir: workspace/shared/sandbox-results
```

The file name controls the discovered plugin concern key. Keep it aligned with
the plugin namespace (`tools-terminal-sandbox`) and set the explicit package id
inside the file.

## Config Options That Matter In Practice

| Setting | When to change it | Notes |
| --- | --- | --- |
| `defaultRuntime` | When most commands are Node or Python instead of shell | Defaults to `bash`. |
| `ensureImages` | When startup latency matters more than preflight certainty | Defaults to `true`. |
| `defaultPolicy.resources.cpuCores` | CPU-heavy commands or tighter multi-tenant controls | Defaults to `1`. |
| `defaultPolicy.resources.memoryMb` | Node/Python jobs with larger working sets | Defaults to `512`. |
| `defaultPolicy.resources.diskMb` | Commands that emit larger artifacts | Limits writable sandbox output. |
| `defaultPolicy.resources.timeoutMs` | Long-running commands | Timeout still produces a structured result. |
| `defaultPolicy.resources.timeoutGraceMs` | Commands that need a graceful shutdown window | Applied before forced termination. |
| `defaultPolicy.resources.maxOutputBytes` | Commands that can spam stdout/stderr | Streams truncate independently. |
| `defaultPolicy.network.mode` | Tighten or loosen egress | `isolated`, `allowlist`, or `open`. |
| `defaultPolicy.network.allowlist` | `allowlist` mode | Required when `mode: allowlist`. |
| `defaultPolicy.files.mode` | Control how much of the workspace is visible | `readonly-mount`, `copy`, or `none`. |
| `defaultPolicy.files.copyInPaths` | `copy` mode | Required in `copy` mode. |
| `defaultPolicy.files.copyOutPaths` | `copy` mode | Explicit paths mirrored back after execution. |
| `defaultPolicy.files.maxInputBytes` | Large workspaces | Caps staged workspace size. |
| `defaultPolicy.files.outputDir` | Artifact routing | Defaults to `workspace/shared/sandbox-results`. |

See [`plugin-api-reference.md`](plugin-api-reference.md) for the full type
surface.

## Verification

### API-Level Verification

Run the focused suites that exercise the documented contract:

```bash
npx vitest run packages/preset-starter-hono/src/index.test.ts
npx vitest run packages/sdk/test/contracts/sandbox-contract.test.ts packages/plugin-tools-terminal-sandbox/test/index.test.ts
```

### Runtime Smoke

After wiring the sandbox plugin into the starter preset, run a small command and
check the result fields:

- `status` should be `succeeded`
- `unrestrictedLocal` should be `false`
- `cwd` should point at the host workspace path
- `sandboxCwd` should point at the in-container workspace path
- artifacts should land under `workspace/shared/sandbox-results/<sessionId>/`

## Troubleshooting

### `Docker is unavailable`

Cause: the plugin calls Docker during `isAvailable()`, `createSession()`, or
image preflight and cannot reach the daemon.

What to do:

- run `docker info`
- start Docker Desktop or the host daemon
- retry the focused sandbox test suite

The plugin raises `SandboxUnavailableError` for session-creation failures so the
caller gets a clear operational error instead of a crash.

### `allowlist` mode fails immediately

Cause: `policy.network.mode` is `allowlist`, but no allowlist entries were
provided.

What to do:

- add `policy.network.allowlist`
- use exact hosts, `host:port`, or wildcard subdomains like `*.example.dev`

### `copy` mode fails immediately

Cause: `policy.files.mode` is `copy`, but `copyInPaths` is empty.

What to do:

- provide at least one workspace-relative `copyInPaths` entry
- keep `copyInPaths` and `copyOutPaths` relative to the workspace; do not use
  absolute paths or `..`

### Commands time out or exit with `oom`

Cause: the command exceeded `timeoutMs` or the memory ceiling.

What to do:

- inspect `status`, `timedOut`, `stderr`, and `resourceUsage`
- increase `resources.timeoutMs`, `resources.timeoutGraceMs`, or
  `resources.memoryMb` only when the workload justifies it
- keep the default conservative ceilings for untrusted or user-generated code

### Output is missing or incomplete

Cause: `resources.maxOutputBytes` truncated one or both streams.

What to do:

- inspect `truncated`, `stdoutTruncated`, and `stderrTruncated`
- increase `maxOutputBytes` if the command legitimately emits more output
- route large machine-readable outputs to files under `outputDir` instead of
  relying on stdout

### Expected files are not available on the host

Cause: in `readonly-mount` mode, only the writable sandbox output directory is
copied back automatically. In `copy` mode, only `copyOutPaths` are mirrored.

What to do:

- check `artifacts` / `generatedFiles` in the result
- confirm the file lands under the configured `outputDir`
- if you use `copy` mode, add the path to `copyOutPaths`
