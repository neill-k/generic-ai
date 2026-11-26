# Pi Boundary (removed)

Generic AI no longer depends on `@mariozechner/pi-coding-agent`. Agent sessions
run on the native runtime (`@generic-ai/ai`, `@generic-ai/agent` and the
packages around them), and the `@generic-ai/sdk/pi` compatibility subpath, the
`pi` adapter and the `openai-codex` adapter have been removed.

- Plugin tools use the runtime-neutral contract in `@generic-ai/sdk`
  (`defineTool`, `ToolDefinition`, `AgentToolResult`).
- Kernel translation code stays in `packages/core/src/runtime`.
- The decision is recorded in `docs/decisions/0068-native-runtime-default.md`,
  which supersedes `docs/decisions/0011-pi-direct-boundary.md`. The parity work
  that replaced `pi` is tracked in `docs/planning/native-harness-parity.md`.

This file is kept so older links resolve.
