import {
  type McpClientManager,
  type McpClientManagerOptions,
  createMcpClientManager,
} from "./client.js";
import { type McpPluginConfig, parseMcpPluginConfig } from "./config.js";
import type { McpLaunchDefinition, McpServerDefinition } from "./registry.js";
import {
  type CreateMcpHarnessToolsOptions,
  createMcpHarnessTools,
  type McpHarnessTool,
} from "./tools.js";

export * from "./client.js";
export * from "./config.js";
export * from "./registry.js";
export * from "./tools.js";

/**
 * The harness `mcp` capability: the registry view used by the `mcp_registry` tool, plus
 * `harnessTools()`, which the harness calls once per run to expose the servers' tools to agents
 * under role effect policies.
 */
export interface McpHarnessCapability {
  list(): readonly McpServerDefinition[];
  get(id: string): McpServerDefinition | undefined;
  resolveLaunch(id: string, envOverrides?: Readonly<Record<string, string>>): McpLaunchDefinition;
  describeForPrompt(): string;
  harnessTools(): Promise<readonly McpHarnessTool[]>;
}

export function createMcpHarnessCapability(
  manager: McpClientManager,
  options: CreateMcpHarnessToolsOptions = {},
): McpHarnessCapability {
  return Object.freeze({
    list: () => manager.list(),
    get: (id: string) => manager.get(id),
    resolveLaunch: (id: string, envOverrides?: Readonly<Record<string, string>>) =>
      manager.resolveLaunch(id, envOverrides),
    describeForPrompt: () => manager.describeForPrompt(),
    harnessTools: () => createMcpHarnessTools(manager, options),
  });
}

export interface McpPlugin {
  readonly config: McpPluginConfig;
  readonly manager: McpClientManager;
  /** Bind as `capabilities.mcp` on an agent harness run. */
  readonly capability: McpHarnessCapability;
  close(): Promise<void>;
}

/**
 * Build the MCP plugin from its config (the `config:` block of `.generic-ai/plugins/plugin-mcp.yaml`).
 * Connections open lazily when the harness first asks for tools.
 */
export function createMcpPlugin(
  config: unknown,
  options: Omit<McpClientManagerOptions, "servers"> = {},
): McpPlugin {
  const parsed = parseMcpPluginConfig(config);
  const manager = createMcpClientManager({
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    ...(parsed.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: parsed.connectTimeoutMs }),
    ...(parsed.reconnect === undefined ? {} : { reconnect: parsed.reconnect }),
    ...(parsed.retryOnDisconnect === undefined
      ? {}
      : { retryOnDisconnect: parsed.retryOnDisconnect }),
    ...options,
    servers: parsed.servers,
  });
  const capability = createMcpHarnessCapability(
    manager,
    parsed.maxOutputChars === undefined ? {} : { maxOutputChars: parsed.maxOutputChars },
  );
  return Object.freeze({
    config: parsed,
    manager,
    capability,
    close: () => manager.close(),
  });
}
