# Agent Lifecycle Hooks

Agent lifecycle hooks let a Generic AI run be governed by deterministic code at key points in the agent loop. They are framework-native contracts, not copies of Codex or Claude Code dotfiles.

Hooks are configured in `.generic-ai/hooks.yaml`:

```yaml
schemaVersion: v1
defaults:
  timeoutMs: 5000
  failureMode: fail-closed
hooks:
  - id: inject-project-context
    events:
      - UserPromptSubmit
    handler:
      type: command
      command: node
      args:
        - ./hooks/inject-project-context.mjs
```

First-pass events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`.

Command handlers receive a JSON hook context on stdin. They may print a JSON decision to stdout:

```json
{
  "decision": "append_context",
  "additionalContext": "Prefer reproducible commands and cite generated artifacts."
}
```

Supported decisions are `allow`, `block`, `rewrite`, `append_context`, and `observe`. Empty stdout with exit code `0` is treated as `allow`; exit code `2` is treated as `block` unless stdout provides a more specific reason. Other non-zero exits follow the configured failure mode.

Hook decisions are inspectable in four places:

- canonical `hook.*` events,
- harness event projections,
- the `hook-decisions` artifact,
- `AgentHarnessRunResult.hookDecisions`.

The SDK also models future `http`, `mcp`, `prompt`, and `agent` handler types, but command handlers and registered in-process handlers are the runtime-supported handler types in this first pass.
