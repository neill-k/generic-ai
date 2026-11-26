# @generic-ai/plugin-mcp

Model Context Protocol client for Generic AI, packaged as a plugin so MCP is never a kernel hard
requirement. It connects to the MCP servers named in config, over stdio or HTTP, and exposes their
tools to agents as ordinary harness tools. Role effect policies decide which roles may call which
tools, so a role that may not write never sees a writing MCP tool.

It is built on the official `@modelcontextprotocol/sdk` client.

## Configure servers

Servers live under `config:` in `.generic-ai/plugins/plugin-mcp.yaml`:

```yaml
plugin: "@generic-ai/plugin-mcp"
config:
  timeoutMs: 60000            # per-call timeout (default 60s)
  connectTimeoutMs: 30000     # connect + initialize timeout (default 30s)
  reconnect: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 10000 }
  retryOnDisconnect: read-only  # never | read-only | always
  servers:
    - id: filesystem
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      readOnly: true
    - id: github
      transport: http          # Streamable HTTP; use `sse` for legacy SSE servers
      url: https://api.githubcopilot.com/mcp/
      headers:
        Authorization: "Bearer ${GITHUB_TOKEN}"
      tools:
        exclude: [delete_repository]
      effects: [network.egress]
```

`${VAR}` placeholders in `command`, `args`, `env`, `url` and `headers` resolve from the process
environment when the server connects, so secrets stay out of config files. A missing variable fails
that server with a clear `MISSING_ENV` error.

Per-server fields:

| Field | Meaning |
| --- | --- |
| `id`, `transport` | Required. `transport` is `stdio`, `http` or `sse`. |
| `command`, `args`, `env`, `cwd` | stdio launch. `env` is layered over a minimal safe environment. |
| `url`, `headers` | http/sse endpoint and request headers. |
| `enabled` | `false` keeps the server registered but never connects it. |
| `required` | `true` fails the run if the server cannot connect. Otherwise its tools are left out. |
| `timeoutMs` | Per-call timeout for this server. |
| `toolPrefix` | Harness tool name prefix. Defaults to `mcp__<id>`. |
| `tools.include`, `tools.exclude` | Which of the server's tools reach agents. |
| `readOnly` | Treat every tool on the server as read-only. |
| `readOnlyTools` | Tool names to treat as read-only. |
| `trustAnnotations` | Honour the server's `readOnlyHint` annotations. Defaults to `true`. |
| `effects` | Extra effects added to every tool, such as `network.egress`. |
| `toolEffects` | Per-tool effect lists that replace the computed effects. |

## How tools reach agents

```ts
import { createAgentHarness } from "@generic-ai/core";
import { createMcpPlugin } from "@generic-ai/plugin-mcp";

const mcp = createMcpPlugin(pluginConfig.config);
try {
  await harness.run({ instruction, workspaceRoot, harness: config, capabilities: { mcp: mcp.capability } });
} finally {
  await mcp.close();
}
```

`mcp.capability` is the harness `mcp` capability. Once per run the harness calls its
`harnessTools()`, which connects the servers (lazily, in parallel) and turns each server tool into a
tool named `mcp__<server>__<tool>` (sanitized, at most 64 characters). The tools join
`customTools`, so role policies, lifecycle hooks and both the pi and native runtimes treat them like
any other tool.

Each tool carries SDK effect metadata:

- Read-only tools get `mcp.read`. Read-only, coordinator, verifier and builder roles may call them.
- Every other tool gets `mcp.read` and `mcp.write`. Only builder roles may call them.
- `effects` and `toolEffects` in config add to or replace these.
- When a run sets `allowMcp: false`, every MCP effect is denied. The `benchmark-container` profile
  drops the MCP capability unless `allowMcp` is set.

A tool is read-only when the server is `readOnly`, the tool is in `readOnlyTools`, or the server
marks it `readOnlyHint: true` and `trustAnnotations` is not `false`. Annotations come from the
server, so set `trustAnnotations: false` for servers you do not control.

Outside the harness, call `createMcpHarnessTools(manager)` and pass the tools as `customTools`.

## Reconnects

Each server connection opens on first use. When a stdio process exits or an HTTP session
disappears, the client reconnects with exponential backoff (`reconnect`), refreshes the tool list,
and keeps serving calls under the same tool names. After the attempts run out the server is marked
`failed`, and the next call tries again.

A call that fails because the connection dropped is retried once after reconnecting when
`retryOnDisconnect` allows it. The default, `read-only`, retries read-only tools only, because a
dropped write may already have reached the server. Other failures surface as `GenericAIToolError`
with an `upstream_unavailable` envelope and a retry hint. Tool errors reported by the server
(`isError`) surface as `GenericAIToolError` with the server's message.

Servers that announce `notifications/tools/list_changed` have their tool list refreshed; the next
run sees the new tools.

`manager.status()` reports each server's state, tool count, connect count and last error, and
`onEvent` receives connect, disconnect, reconnect, tool-change and server stderr events.

## Registry only

`createMcpRegistry()` is still available for code that only needs validated server metadata and
launch resolution, such as the runtime `mcp_registry` tool.

Planning baseline:

- `docs/planning/02-architecture.md`
- `docs/package-boundaries.md`
- `docs/runtime-governance.md`
