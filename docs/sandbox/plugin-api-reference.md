# Sandbox Plugin API Reference

This reference documents the public sandbox surface exposed by
`@generic-ai/sdk` and `@generic-ai/plugin-tools-terminal-sandbox`.

## Minimal Example

```ts
import { createSandboxTerminalPlugin } from "@generic-ai/plugin-tools-terminal-sandbox";

const plugin = createSandboxTerminalPlugin({
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

const result = await plugin.run({
  runtime: "node",
  command: "node -p \"process.version\"",
});
```

## `@generic-ai/sdk` Contract Surface

### Runtime, Policy, And Status Unions

| Export | Values | Notes |
| --- | --- | --- |
| `SandboxRuntime` | `"bash" \| "node" \| "python"` | Selects the default image/tooling family. |
| `SandboxNetworkMode` | `"isolated" \| "allowlist" \| "open"` | Network isolation policy. |
| `SandboxFileIOMode` | `"readonly-mount" \| "copy" \| "none"` | Workspace exposure strategy. |
| `SandboxExecutionStatus` | `"succeeded" \| "failed" \| "timed_out" \| "oom" \| "signaled" \| "unavailable"` | Backend-neutral result classification. |
| `SandboxOutputStream` | `"stdout" \| "stderr"` | Stream id used by output callbacks. |

### Output Types

#### `SandboxOutputChunk`

| Field | Type | Meaning |
| --- | --- | --- |
| `stream` | `SandboxOutputStream` | Which output stream produced this chunk. |
| `text` | `string` | UTF-8 text payload for the chunk. |

#### `SandboxOutputListener`

Callback signature:

```ts
type SandboxOutputListener = (
  chunk: SandboxOutputChunk,
) => void | Promise<void>;
```

Use it when the backend should surface output incrementally during a long run.

### Artifact And Usage Types

#### `SandboxArtifact`

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | `string` | Relative path for a produced file. |
| `sizeBytes` | `number \| undefined` | Best-effort artifact size. |
| `contentType` | `string \| undefined` | Best-effort content type hint. |

#### `SandboxResourceUsage`

| Field | Type | Meaning |
| --- | --- | --- |
| `peakMemoryMb` | `number \| undefined` | Peak observed memory use. |
| `cpuTimeMs` | `number \| undefined` | Best-effort CPU time. |
| `wallClockMs` | `number \| undefined` | Total elapsed time. |
| `diskWrittenMb` | `number \| undefined` | Best-effort writable-output usage. |

### Policy Types

#### `SandboxResourceLimits`

| Field | Type | Meaning |
| --- | --- | --- |
| `cpuCores` | `number \| undefined` | Maximum virtual CPUs. |
| `memoryMb` | `number \| undefined` | Memory ceiling in MiB. |
| `diskMb` | `number \| undefined` | Writable-output ceiling in MiB. |
| `timeoutMs` | `number \| undefined` | Wall-clock timeout for a command. |
| `timeoutGraceMs` | `number \| undefined` | Grace period between timeout termination attempts. |
| `maxOutputBytes` | `number \| undefined` | Maximum UTF-8 bytes preserved per output stream. |

#### `SandboxNetworkPolicy`

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `SandboxNetworkMode` | `isolated`, `allowlist`, or `open`. |
| `allowlist` | `readonly string[] \| undefined` | Required when `mode` is `allowlist`. Entries may be host names, `host:port`, or `*.domain` wildcards. |

#### `SandboxFileIOPolicy`

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `SandboxFileIOMode` | `readonly-mount`, `copy`, or `none`. |
| `maxInputBytes` | `number \| undefined` | Maximum bytes staged into the sandbox workspace. |
| `copyInPaths` | `readonly string[] \| undefined` | Required for `copy` mode. Workspace-relative inputs to stage. |
| `copyOutPaths` | `readonly string[] \| undefined` | Optional workspace-relative outputs to mirror back when `copy` mode is used. |
| `outputDir` | `string \| undefined` | Workspace-relative host path used for writable artifacts. |

#### `SandboxPolicy`

| Field | Type | Meaning |
| --- | --- | --- |
| `resources` | `SandboxResourceLimits \| undefined` | Resource ceilings. |
| `network` | `SandboxNetworkPolicy \| undefined` | Outbound networking policy. |
| `files` | `SandboxFileIOPolicy \| undefined` | Workspace/file exposure policy. |

#### `SandboxRuntimeConfig`

| Field | Type | Meaning |
| --- | --- | --- |
| `image` | `string \| undefined` | Explicit image override. |
| `env` | `Readonly<Record<string, string>> \| undefined` | Extra environment variables injected into the sandbox container. |
| `workdir` | `string \| undefined` | Backend-specific working directory override. |
| `volumes` | `readonly string[] \| undefined` | Additional bind mounts exposed to the sandbox. |

### Session Lifecycle Types

#### `SandboxSessionRequest`

| Field | Type | Meaning |
| --- | --- | --- |
| `runtime` | `SandboxRuntime` | Runtime/image family. |
| `sessionId` | `string \| undefined` | Optional caller-supplied stable id. Must match `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/` (Docker-safe). |
| `workspaceRoot` | `string` | Host workspace root for the session. The Docker backend requires this value to equal the plugin's configured `root`; a mismatch throws `SandboxConfigurationError`. |
| `cwd` | `string \| undefined` | Optional workspace-relative working directory. |
| `policy` | `SandboxPolicy \| undefined` | Session-level policy overrides. |
| `runtimeConfig` | `SandboxRuntimeConfig \| undefined` | Backend/runtime overrides. |

#### `SandboxSession`

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | `string` | Stable session id. |
| `backend` | `string` | Backend id such as `docker`. |
| `runtime` | `SandboxRuntime` | Runtime family in use. |
| `image` | `string` | Concrete image used for the session. |
| `containerId` | `string` | Backend-native identifier. |
| `workspaceRoot` | `string` | Host workspace root. |
| `outputDir` | `string` | Host output directory for writable artifacts. |
| `createdAt` | `string` | ISO timestamp for session creation. |

#### `SandboxExecutionRequest`

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | `string` | Target session id. |
| `command` | `string` | Shell command executed inside the sandbox. |
| `cwd` | `string \| undefined` | Optional workspace-relative working directory override. |
| `env` | `Readonly<Record<string, string>> \| undefined` | Command-scoped environment variables. |
| `timeoutMs` | `number \| undefined` | Command-scoped timeout override. |
| `onOutput` | `SandboxOutputListener \| undefined` | Optional streaming callback. |
| `signal` | `AbortSignal \| undefined` | Optional caller-supplied abort signal. |

#### `SandboxExecutionResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | `string` | Executed command string. |
| `runtime` | `SandboxRuntime` | Runtime family in use. |
| `image` | `string` | Concrete backend image. |
| `cwd` | `string` | Host working directory for compatibility with `TerminalRunResult`. |
| `sandboxCwd` | `string` | In-container working directory. |
| `exitCode` | `number \| null` | Exit code or `null` when the command is forcibly terminated. |
| `stdout` | `string` | Captured stdout after optional truncation. |
| `stderr` | `string` | Captured stderr after optional truncation. |
| `output` | `string` | Compatibility field combining stdout and stderr. |
| `durationMs` | `number` | Total runtime in milliseconds. |
| `timedOut` | `boolean` | Timeout flag. |
| `truncated` | `boolean` | Whether any stream was truncated. |
| `stdoutTruncated` | `boolean` | Whether stdout hit `maxOutputBytes`. |
| `stderrTruncated` | `boolean` | Whether stderr hit `maxOutputBytes`. |
| `status` | `SandboxExecutionStatus` | Backend-neutral outcome. |
| `artifacts` | `readonly SandboxArtifact[]` | Produced files. |
| `generatedFiles` | `readonly SandboxArtifact[]` | Compatibility alias for `artifacts`. |
| `resourceUsage` | `SandboxResourceUsage \| undefined` | Best-effort runtime usage snapshot. |
| `unrestrictedLocal` | `false` | Compatibility field distinguishing sandbox execution from host execution. |

### `SandboxContract`

```ts
interface SandboxContract {
  readonly backend: string;
  isAvailable(): Promise<boolean>;
  createSession(request: SandboxSessionRequest): Promise<SandboxSession>;
  exec(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  destroy(sessionId: string): Promise<void>;
}
```

This is the backend-neutral contract that sandbox plugins implement.

### Validation And Merge Helpers

`@generic-ai/sdk` also exports:

- `SANDBOX_RESOURCE_LIMITS_SCHEMA`
- `SANDBOX_POLICY_SCHEMA`
- `SANDBOX_RUNTIME_CONFIG_SCHEMA`
- `parseSandboxPolicy(input)`
- `parseSandboxRuntimeConfig(input)`
- `mergeSandboxPolicy(base, next)`

Use these when plugin registration or bootstrap needs to validate or merge
partial sandbox policy/config objects.

## `@generic-ai/plugin-tools-terminal-sandbox`

### High-Value Exports

| Export | Purpose |
| --- | --- |
| `createSandboxTerminalPlugin(options)` | Creates the runtime-backed sandbox plugin instance. |
| `sandboxTerminalConfigSchema` | Config-schema contract for plugin registration/bootstrap validation. |
| `sandboxTerminalPluginContract` | Public plugin contract metadata. |
| `sandboxTerminalPluginDefinition` | Plugin-host compatible manifest shape. |
| `createDockerCliSandboxOperations()` | Default Docker CLI adapter used by the plugin. |
| `isDockerDaemonReachable()` | Convenience Docker availability probe. |
| `SandboxUnavailableError` | Explicit error raised when Docker is unavailable during session creation. |
| `SANDBOX_DEFAULT_IMAGES` | Default image map for `bash`, `node`, and `python`. |
| `SANDBOX_DEFAULT_POLICY` | Default resource/network/file policy. |
| `SANDBOX_DEFAULT_MAX_INPUT_BYTES` | Default staged-workspace size cap (`256 MiB`). |

### `SandboxTerminalPluginConfig`

| Field | Type | Meaning |
| --- | --- | --- |
| `backend` | `"docker"` | Current backend selector. |
| `defaultRuntime` | `SandboxRuntime` | Runtime used by `run()` when the request omits `runtime`. |
| `images` | `Readonly<Record<SandboxRuntime, string>>` | Runtime-to-image mapping. |
| `defaultPolicy` | `SandboxPolicy` | Default session policy merged with request overrides. |
| `ensureImages` | `boolean` | Whether to preflight image availability before session creation. |

### `SandboxTerminalPluginOptions`

| Field | Type | Meaning |
| --- | --- | --- |
| `root` | `WorkspaceRootInput` | Required workspace root. |
| `config` | `Partial<SandboxTerminalPluginConfig> \| undefined` | Optional config overrides. |
| `dockerOperations` | `SandboxDockerOperations \| undefined` | Test seam or custom Docker adapter. |
| `sessionIdFactory` | `() => string \| undefined` | Optional stable session id factory. |
| `now` | `() => number \| undefined` | Optional clock override for tests. |

### `SandboxRunRequest`

`run()` is a one-shot helper: when `sessionId` is omitted it creates an
ephemeral session, execs the command, and destroys the session; when
`sessionId` is provided it still creates a session with that id, execs, and
destroys it (so the caller gets a deterministic id for artifact paths without
managing the session lifecycle themselves). If the provided id collides with
an active session, `run()` surfaces a `SandboxSessionConflictError`; destroy
the previous session before reusing the id.

| Field | Type | Meaning |
| --- | --- | --- |
| `runtime` | `SandboxRuntime \| undefined` | Runtime override. |
| `sessionId` | `string \| undefined` | Optional caller-provided session id. |
| `command` | `string` | Command to run. |
| `cwd` | `string \| undefined` | Working directory override. |
| `env` | `Readonly<Record<string, string>> \| undefined` | Command env overrides. |
| `timeoutMs` | `number \| undefined` | Command timeout override. |
| `policy` | `SandboxPolicy \| undefined` | Session policy override. |
| `runtimeConfig` | `SandboxRuntimeConfig \| undefined` | Runtime/backend override. |
| `onOutput` | `SandboxOutputListener \| undefined` | Optional streaming callback. |
| `signal` | `AbortSignal \| undefined` | Optional abort signal. |

### `SandboxTerminalPlugin`

`SandboxTerminalPlugin` extends `SandboxContract` and adds:

- `name`
- `kind`
- `root`
- `config`
- `pluginContract`
- `pluginDefinition`
- `run(request)`
- `listSessions()`
- `destroyAll()`

### Default Policy Summary

| Setting | Default |
| --- | --- |
| `defaultRuntime` | `bash` |
| `images.bash` | `node:24-bookworm-slim` |
| `images.node` | `node:24-bookworm-slim` |
| `images.python` | `python:3.12-slim` |
| `resources.timeoutMs` | `30_000` |
| `resources.timeoutGraceMs` | `5_000` |
| `resources.memoryMb` | `512` |
| `resources.cpuCores` | `1` |
| `resources.diskMb` | `100` |
| `network.mode` | `isolated` |
| `files.mode` | `readonly-mount` |
| `files.maxInputBytes` | `268_435_456` |
| `files.outputDir` | `workspace/shared/sandbox-results` |

### Example Plugin Config File

Canonical YAML plugin config is discovered from `.generic-ai/plugins/*.yaml`.
Keep the file name aligned with the concern key and set the explicit package id:

```yaml
# .generic-ai/plugins/tools-terminal-sandbox.yaml
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
    maxOutputBytes: 131072
  network:
    mode: isolated
  files:
    mode: readonly-mount
    outputDir: workspace/shared/sandbox-results
```

## Out Of Scope For This Reference

The internal Docker adapter types (`SandboxDockerOperations`,
`SandboxDockerCreateContainerRequest`, and related low-level structures) are
useful implementation seams, but they are not the primary consumer-facing
contract. Treat them as backend internals unless you are actively swapping the
Docker transport implementation.
