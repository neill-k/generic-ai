# 0013. Sandboxed Code Execution For Terminal Tools

Status: accepted

## Context

`@generic-ai/plugin-tools-terminal` currently executes commands on the host via `createLocalBashOperations()` and advertises `unrestrictedLocal: true` by default. The starter preset wires that package into the required `terminalTools` slot, so the default "it works" path is intentionally local-first and intentionally not isolated.

That posture is acceptable for single-user local development, but it is the wrong default for production or multi-tenant execution. The framework needs a safer path for agent-generated code without breaking the existing repo boundaries:

- the kernel must stay plugin-agnostic (`docs/package-boundaries.md`)
- the starter preset owns capability composition (`packages/core/src/bootstrap/starter-preset.ts`, `packages/preset-starter-hono/src/index.ts`)
- the tool surface should stay close to the current `pi`-backed terminal model instead of inventing a kernel-owned execution abstraction

The planning question is therefore not "should code run in a sandbox?" but "which sandbox boundary fits the current Generic AI architecture and contributor workflow best?"

## Decision

Generic AI will add a new terminal-slot plugin, `@generic-ai/plugin-tools-terminal-sandbox`, and make Docker the first backend it targets. The existing `@generic-ai/plugin-tools-terminal` package remains the explicit unsandboxed local-development path.

The public architecture is:

- one user-facing sandboxed terminal plugin package that can replace the starter preset `terminalTools` slot
- a backend-neutral `SandboxContract` owned by that plugin surface
- a Docker implementation behind that contract in v1
- no kernel changes beyond consuming the replacement terminal plugin through existing preset/bootstrap composition

### Isolation model

The initial options were evaluated against the repo's current shape: local-first starter preset, Node and Python expectations, workspace-aware tools, and cross-platform contributors.

| Approach | Strengths | Weaknesses | Decision |
| --- | --- | --- | --- |
| Docker containers | Mature process isolation, filesystem mounts, stdout/stderr capture, resource flags, broad Node/Python compatibility, realistic local-dev story | Weaker boundary than microVMs, requires local daemon/runtime, platform quirks on Windows/macOS | **Chosen for v1** |
| Firecracker / microVMs | Stronger isolation and tighter tenant boundary | Much higher operational cost, worse local-dev ergonomics, harder image/runtime management, more CI and platform work | Deferred until a real multi-tenant need justifies the cost |
| Wasm / V8 isolates | Fast startup, small footprint, attractive for tightly-scoped code | Poor fit for arbitrary shell workflows, weak package-install story for Python/Node, large compatibility gap vs current terminal tool expectations | Rejected for the terminal-tool use case |

Docker is the best fit for the current repo because it preserves the ability to run shell, Python, and Node workloads while still enforcing CPU, memory, timeout, mount, and network boundaries with tooling contributors can actually run locally.

### Plugin boundary and package shape

The sandbox boundary should stay focused on terminal/code execution rather than becoming a monolithic "security" plugin.

The chosen package shape is:

- `@generic-ai/plugin-tools-terminal`: host execution, explicit `unrestrictedLocal` dev path
- `@generic-ai/plugin-tools-terminal-sandbox`: sandboxed execution path for the same starter preset slot
- future backend adapters only if a second backend becomes real; do not publish `-docker`, `-firecracker`, or `-wasm` packages before there is more than one supported backend

This keeps the kernel and preset boundaries intact:

- `@generic-ai/core` still composes a terminal plugin through preset plugin specs
- `@generic-ai/preset-starter-hono` still owns which terminal plugin occupies the `terminalTools` slot
- plugin-specific policy stays out of the kernel

### Contract sketch

The agent-facing tool should remain "bash-compatible" so prompts, examples, and starter composition do not need a semantic rewrite just to gain isolation. The sandbox-specific session lifecycle lives behind a plugin-local contract.

```ts
type SandboxBackend = "docker";
type SandboxNetworkMode = "isolated" | "allowlist" | "open";
type SandboxWorkspaceMode = "readonly-mount" | "copy";

interface SandboxContract {
  readonly backend: SandboxBackend;
  createSession(request: SandboxSessionRequest): Promise<SandboxSessionHandle>;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  destroy(sessionId: string): Promise<void>;
}

interface SandboxSessionRequest {
  readonly runtime: "bash" | "python" | "node";
  readonly workspace: {
    readonly root: string;
    readonly mode: SandboxWorkspaceMode;
    readonly outputDir: string;
  };
  readonly resources: {
    readonly cpu?: number;
    readonly memoryMb?: number;
    readonly diskMb?: number;
    readonly timeoutMs?: number;
  };
  readonly network: {
    readonly mode: SandboxNetworkMode;
    readonly allowlist?: readonly string[];
  };
  readonly env?: Record<string, string>;
}

interface SandboxExecRequest {
  readonly sessionId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "oom" | "signaled";
  readonly durationMs: number;
  readonly artifacts: readonly SandboxArtifact[];
}
```

The agent-facing terminal tool can keep the current `bash` semantics while the plugin implementation routes execution through `SandboxContract.exec()` instead of host `createLocalBashOperations()`.

### Language support and package installation

Initial runtime targets are:

- Node LTS image
- Python 3.x image
- shell entrypoint for generic command execution

Package installation remains allowed only inside the sandbox and only when the network policy permits it. The v1 implementation should prefer:

- prebuilt base images with common tooling already present
- ephemeral per-session install state unless an explicit cache volume is configured
- no host package-manager passthrough

This keeps package installation compatible with current terminal-tool expectations without turning the host machine into the agent's execution substrate.

### Resource limits

Resource control is mandatory, not optional hardening. The model is:

- plugin config defines defaults and maximums
- individual tool calls may tighten those limits, but not exceed plugin maxima
- timeout, CPU, memory, and disk exhaustion are returned as structured statuses instead of ambiguous text output

Recommended v1 defaults:

- `timeoutMs`: 300000
- memory: 1 to 2 GiB
- CPU: 1 to 2 cores
- writable disk/artifact area: bounded, not host-unlimited

### Network policy

The default policy is `isolated`.

Allowed profiles:

- `isolated`: no outbound network
- `allowlist`: explicit host/port or domain allowlist for install or API workflows
- `open`: development-only escape hatch, disabled by default

This policy applies only to code running inside the sandbox. A future `plugin-tools-web`-style capability remains a separate host-side plugin boundary; it must not be treated as an implicit escape hatch for sandboxed code. If code running inside the sandbox needs outbound HTTP, that access must be granted and enforced by the sandbox plugin itself.

### File I/O model

The default workspace model is:

- mount the workspace root read-only into the sandbox
- provide a separate writable output/artifact directory
- return explicit artifact metadata to the caller

This is safer than giving the container write access to the repo checkout. It also keeps file mutation semantics aligned with the existing split between terminal tools and `@generic-ai/plugin-tools-files`.

`copy` mode is still useful for tests and narrow one-shot workloads, but it should be the exception rather than the default because it is slower and makes large workspaces awkward.

### Output capture

The sandbox result must be more structured than the current merged `output` string returned by `@generic-ai/plugin-tools-terminal`.

Required output fields in v1:

- separate `stdout` and `stderr`
- exit code
- terminal status (`succeeded`, `failed`, `timed_out`, `oom`, `signaled`)
- duration
- artifact list

This gives the framework enough shape to reason about failures and generated outputs without forcing the kernel to own terminal-specific policy.

### Migration path from unsandboxed terminal execution

Migration should not require kernel rewrites.

Programmatic migration path:

```ts
import { createStarterHonoPreset } from "@generic-ai/preset-starter-hono";

const preset = createStarterHonoPreset({
  slotOverrides: [
    {
      slot: "terminalTools",
      pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
    },
  ],
});
```

Config-driven migration should continue using the `terminal-tools` concern under `.generic-ai/plugins/`, with the plugin namespace selecting the sandbox implementation and its policy:

```yaml
plugin: "@generic-ai/plugin-tools-terminal-sandbox"
backend: docker
network:
  mode: isolated
resources:
  timeoutMs: 300000
  memoryMb: 2048
  cpu: 2
workspace:
  mode: readonly-mount
  outputDir: workspace/shared/results
```

That keeps the current local path available for development while making the production-safe path explicit.

### Estimated effort and dependencies

The implementation splits cleanly into the follow-on Linear slices that already exist:

1. `NEI-374`: Docker-backed sandbox package and lifecycle
2. `NEI-375`: resource limits and timeout enforcement
3. `NEI-376`: network policy engine
4. `NEI-377`: file I/O bridge
5. `NEI-378`: structured output and artifact collection
6. `NEI-379`: starter preset/bootstrap wiring
7. `NEI-380`: integration and security validation
8. `NEI-381`: operator docs and migration guide

External dependencies and assumptions:

- Docker-compatible runtime on contributor and CI machines
- Windows support likely routed through Docker Desktop plus WSL2/Hyper-V, not a bespoke kernel path
- test runners that can launch containers deterministically

## Consequences

- Generic AI gains a credible production-oriented terminal execution path without collapsing plugin boundaries into the kernel.
- The current local terminal plugin becomes explicitly documented as a host-execution development tool, not a security boundary.
- Docker becomes a runtime dependency for the sandbox path, which increases setup and CI work but stays reasonable for the repo's current maturity.
- The design leaves room for a future stronger backend, but only after a real second backend exists and proves worth the added public surface.

## Alternatives Considered

1. Replace `@generic-ai/plugin-tools-terminal` in place with sandboxed behavior.

   Rejected because the current package is intentionally local-first, already exposes `unrestrictedLocal`, and is useful as an explicit dev path. Overloading it with both host and sandbox semantics would blur a safety-critical boundary.

2. Make Firecracker the default v1 backend.

   Rejected because the operational and contributor-cost jump is too high for the current repo. The framework needs a usable first isolation story before it needs the strongest possible tenant boundary.

3. Build a generic `plugin-sandbox` before any capability-specific integration exists.

   Rejected because the immediate problem is terminal/code execution. A generic package would force premature abstractions across files, network, and possibly MCP without concrete second consumers.
