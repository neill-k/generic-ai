# 0013: Sandboxed Execution

## Context

`@generic-ai/plugin-tools-terminal` executes agent-generated commands directly on
the host workspace and reports `unrestrictedLocal: true`. That is acceptable
for local development, but it is the wrong default posture for production or
multi-tenant deployments where Generic AI needs bounded resource usage, clearer
network controls, and a smaller blast radius when a tool call goes wrong.

The sandbox implementation work now exists as a real stack:

- `@generic-ai/sdk` exposes a backend-neutral sandbox contract
- `@generic-ai/plugin-tools-terminal-sandbox` implements that contract with the
  Docker CLI and one container per session
- `@generic-ai/preset-starter-hono` already exposes a `terminalTools` slot that
  callers can override during bootstrap

What was still missing was a single recorded decision for the operational path:
which terminal implementation Generic AI should treat as the production-facing
default, how callers migrate to it, and what trade-offs remain explicit.

## Decision

Generic AI adopts `@generic-ai/plugin-tools-terminal-sandbox` as the
production-oriented terminal execution path for v1.

The concrete decision is:

- The public contract lives in `@generic-ai/sdk` as `SandboxContract`,
  `SandboxPolicy`, session/request/result types, and schema helpers so future
  backends can swap in without changing caller-facing policy or result shapes.
- The first backend is Docker-backed and lives in
  `@generic-ai/plugin-tools-terminal-sandbox`.
- The default sandbox posture is intentionally conservative:
  read-only workspace staging, isolated networking, explicit writable artifact
  output, and bounded CPU, memory, disk, timeout, and output-size ceilings.
- Starter/bootstrap callers switch to the sandbox through explicit preset
  composition by overriding the `terminalTools` slot to
  `@generic-ai/plugin-tools-terminal-sandbox`.
- `@generic-ai/plugin-tools-terminal` remains a supported local-development
  tool, but Generic AI documentation treats it as an explicit host-execution
  path rather than a production safety boundary.

## Consequences

- Generic AI now has a single documented production terminal story that matches
  the shipped implementation.
- Operators must run Docker CLI + a reachable Docker daemon on the host.
- Sandbox execution becomes policy-driven instead of host-driven: resource,
  network, and file exposure are explicit inputs rather than ambient host state.
- The migration path is incremental because the sandbox result surface remains a
  superset of the existing terminal result shape (`output`, `timedOut`,
  `unrestrictedLocal`, host `cwd` compatibility).
- The sandbox is a meaningful isolation improvement, but not a perfect
  security boundary:
  Docker daemon access is still trusted, allowlist mode only governs outbound
  HTTP(S) traffic from inside the sandbox, and secrets already present in the
  staged workspace remain readable by sandboxed code.
- Later bootstrap conveniences, additional backends, or stronger governance can
  layer on top of this contract without changing the core decision.

## Alternatives Considered

### Keep `@generic-ai/plugin-tools-terminal` as the primary production path

Rejected. It leaves command execution on the host with no isolation boundary,
no resource ceilings, and no operational distinction between local development
and production.

### Start with Firecracker or another microVM backend

Rejected for v1. A microVM-backed design may become attractive later, but it
would slow the first production-capable rollout and does not fit the current
repo's local-first tooling assumptions as cleanly as Docker.

### Start with Wasm or V8 isolates

Rejected for v1. That model is attractive for some workloads, but Generic AI
needs a practical shell-oriented execution path for bash, Node, and Python with
filesystem and toolchain compatibility. Wasm/V8 isolates do not cover that
surface with acceptable friction yet.

### Hide the migration inside the kernel or starter defaults

Rejected. The kernel should stay plugin-agnostic, and operators need an
explicit, reviewable switch from unrestricted host execution to sandboxed
execution instead of a silent behavior change.
