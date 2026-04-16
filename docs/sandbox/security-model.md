# Sandbox Security Model

This document explains what the Docker-backed sandbox does protect, what it
does not protect, and how operators should reason about the remaining risk.

## Security Goals

The sandbox exists to reduce the blast radius of agent-generated terminal
commands by replacing direct host execution with:

- a per-session container
- explicit resource ceilings
- explicit network policy
- explicit file exposure rules
- explicit artifact copy-out

It is not intended to be a perfect isolation boundary against a fully privileged
host attacker.

## Protections The Sandbox Provides

| Protection | How it works | Why it matters |
| --- | --- | --- |
| Host-command isolation | Commands run in a container instead of directly on the host workspace. | The default terminal path is no longer ambient host execution. |
| Resource ceilings | Docker CPU, memory, disk, timeout, and timeout-grace controls are applied through policy. | Prevents runaway commands from consuming unbounded host resources. |
| Read-only workspace staging | Default file mode stages a read-only workspace snapshot. | Prevents accidental direct mutation of the host workspace during ordinary runs. |
| Explicit writable output | Writable files land in the configured output directory and are surfaced as artifacts. | Makes produced files auditable and easier to clean up. |
| Copy mode with explicit paths | `copyInPaths` / `copyOutPaths` must be workspace-relative and are validated. | Limits writable workflows to reviewed paths instead of exposing the full workspace. |
| Network isolation | `isolated`, `allowlist`, and `open` are explicit modes. | Makes outbound access reviewable instead of implicit. |
| Cleanup semantics | Sessions destroy containers explicitly; allowlist mode also removes sidecar proxy containers and networks. | Reduces leaked runtime resources. |

## Deliberate Limitations

| Limitation | Operational meaning |
| --- | --- |
| Docker daemon trust remains in scope | Anyone who can fully control the host Docker daemon can usually escape the intended boundary. |
| Not a microVM boundary | Containers are a practical v1 isolation layer, not the strongest possible isolation story. |
| Allowlist mode governs HTTP(S) egress from inside the sandbox | It does not regulate host-side traffic from other plugins such as `@generic-ai/plugin-tools-web`. |
| Workspace staging is still data exposure | Secrets already present in the staged workspace remain readable by sandboxed code. |
| Read-only mode is not "no data access" | It stops host writes, not host reads. |
| Writable output is copied back to the host | The host still receives produced artifacts by design. Treat that output as untrusted data. |
| Default snapshot excludes only top-level `.git/` and `node_modules/` | Other sensitive files must be controlled through workspace layout and operational hygiene. |

## Threats The Current Design Addresses

- accidental host modification by agent-generated shell commands
- runaway CPU or memory consumption from unbounded commands
- large, uncontrolled writable output on the host filesystem
- silent outbound HTTP(S) access when the operator intended network isolation
- path-traversal attempts in copy-mode input/output selection

## Threats It Does Not Fully Address

- a host-level attacker with Docker daemon control
- sandbox breakout vulnerabilities in Docker, the kernel, or container images
- secrets that are already mounted or staged into the sandbox
- non-HTTP(S) protocols when the operator deliberately chooses `open` networking
- unsafe behavior in host-side plugins that run outside the sandbox boundary

## Recommended Deployment Posture

Use these defaults unless you have a concrete reason not to:

- `network.mode: isolated`
- `files.mode: readonly-mount`
- conservative resource ceilings
- explicit artifact review for anything copied back to the host
- a clean workspace root that does not stage unnecessary secrets

When a workload needs extra capability:

- prefer `allowlist` before `open`
- prefer `copy` mode with explicit path lists before broader workspace exposure
- raise resource ceilings only for workloads that justify it

## Practical Operator Checks

Before trusting a deployment:

- run `docker info`
- run the focused sandbox test suite
- confirm the runtime returns `unrestrictedLocal: false`
- verify commands can only see the workspace inputs you intended
- verify no leaked containers or allowlist networks remain after test runs

Treat the sandbox as an explicit defense layer, not as a reason to stop doing
workspace hygiene, secret minimization, or runtime policy review.
