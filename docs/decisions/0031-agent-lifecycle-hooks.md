# 0031 Agent Lifecycle Hooks

## Context

Generic AI now runs real agent harnesses through the SDK -> core -> Pi spine. Prompt-only governance is not enough for repeatable agent systems: callers need deterministic lifecycle hooks for context injection, tool interception, permission evidence, post-tool observation, and final-stop checks.

Codex and Claude Code both expose hook systems, but their dotfile layouts and full event surfaces are vendor-specific. Generic AI needs a framework-native version that preserves package boundaries and keeps hook decisions visible in canonical traces.

## Decision

Generic AI ships first-pass agent lifecycle hooks as an SDK-owned public contract, a `.generic-ai/hooks.yaml` config concern, and a core runtime executor.

The first event set is:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `Stop`

The first implemented handler type is `command`, with JSON context on stdin, stdout JSON decisions, exit code `0` as allow, exit code `2` as block, timeouts, and explicit fail-open/fail-closed behavior. The SDK also models `in-process`, `http`, `mcp`, `prompt`, and `agent` handler types as future-compatible contracts. Core supports typed in-process handlers when callers register them programmatically, but project-local YAML command handlers are the default portable path.

Hook execution is observable through canonical `hook.*` events, typed harness projections, a `hook-decisions` artifact, and the `hookDecisions` field on harness run results.

## Consequences

Hook contracts are reusable by plugins and presets without importing core. YAML discovery stays in `@generic-ai/plugin-config-yaml`, and core only consumes typed resolved config or harness run input.

Per-tool interception wraps tool `execute` functions rather than relying on Pi runtime event projections, because projections do not include full tool inputs/results. Permission hooks observe policy decision records in the first pass; deeper permission mutation can build on the same contract later.

## Alternatives Considered

Copying `.codex/hooks.json` or `.claude/settings.json` was rejected because it would bind Generic AI public contracts to vendor-specific config surfaces.

Putting hooks in plugin lifecycle was rejected because plugin `setup/start/stop` controls package startup, not agent-loop behavior.

Making HTTP/MCP/prompt/agent handlers runtime-complete in the first PR was rejected to keep the first implementation auditable and testable.
