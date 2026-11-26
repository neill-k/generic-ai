import type { AgentHarnessCapabilityEffect } from "@generic-ai/sdk";

import {
  isMcpConnectorKind,
  MCP_CONNECTOR_KINDS,
  MCP_CONNECTOR_PRESETS,
  type McpConnectorKind,
} from "./connectors.js";

export const name = "@generic-ai/plugin-mcp" as const;
export const kind = "mcp" as const;

export type McpTransport = "stdio" | "http" | "sse";

/** Which of a server's tools reach agents. Names are the server's own tool names. */
export interface McpToolFilter {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface McpServerDefinition {
  readonly id: string;
  readonly transport: McpTransport;
  readonly description?: string;
  /**
   * What kind of external service this server reaches (`email`, `calendar`, `chat`, `documents`,
   * `browser`, `payments` or `generic`). Tools are then classified by name into read-only tools and
   * outward actions tagged `message.send`, `external.write` or `payment.spend`, which approval
   * policies gate. `browser` also supplies a default launch (Playwright MCP, headless, isolated).
   */
  readonly connector?: McpConnectorKind;
  /** stdio: executable to launch. `${VAR}` placeholders resolve from the environment at connect time. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** stdio: extra environment for the server process, layered over a safe default environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** http/sse: server endpoint. */
  readonly url?: string;
  /** http/sse: request headers, for example `Authorization: Bearer ${GITHUB_TOKEN}`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly roots?: readonly string[];
  /** Set false to keep the server in the registry without connecting to it. Defaults to true. */
  readonly enabled?: boolean;
  /** When true, a failed connection fails the run instead of leaving the server's tools out. */
  readonly required?: boolean;
  /** Per-call timeout in milliseconds. Defaults to the client manager's timeout. */
  readonly timeoutMs?: number;
  /** Prefix for harness tool names. Defaults to `mcp__<id>`. */
  readonly toolPrefix?: string;
  readonly tools?: McpToolFilter;
  /** Treat every tool on this server as read-only (effect `mcp.read` only). */
  readonly readOnly?: boolean;
  /**
   * Honour the server's `readOnlyHint` tool annotations when classifying tools. Defaults to true.
   * Set false for servers whose annotations you do not trust; their tools are then treated as writes
   * unless listed in `readOnlyTools` or covered by `readOnly`.
   */
  readonly trustAnnotations?: boolean;
  /** Tool names to treat as read-only regardless of annotations. */
  readonly readOnlyTools?: readonly string[];
  /** Extra effects added to every tool on this server, for example `network.egress`. */
  readonly effects?: readonly AgentHarnessCapabilityEffect[];
  /**
   * Per-tool effect overrides; replaces the computed effects for that tool. Keys are tool names or
   * glob patterns with `*` (for example `send_*`). An exact name wins over a pattern; among patterns
   * the first listed match wins.
   */
  readonly toolEffects?: Readonly<Record<string, readonly AgentHarnessCapabilityEffect[]>>;
}

export interface McpLaunchDefinition {
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
}

export interface McpRegistry {
  readonly name: typeof name;
  readonly kind: typeof kind;
  register(server: McpServerDefinition): void;
  get(id: string): McpServerDefinition | undefined;
  list(): readonly McpServerDefinition[];
  remove(id: string): boolean;
  resolveLaunch(id: string, envOverrides?: Readonly<Record<string, string>>): McpLaunchDefinition;
  describeForPrompt(): string;
}

export class McpRegistryError extends Error {
  constructor(
    public readonly code: "INVALID_ID" | "INVALID_SERVER" | "DUPLICATE_SERVER" | "UNKNOWN_SERVER",
    message: string,
  ) {
    super(message);
    this.name = "McpRegistryError";
  }
}

const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertNonEmpty(value: string | undefined, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new McpRegistryError("INVALID_SERVER", `${label} must be a non-empty string.`);
}

/** Fill launch fields a connector preset supplies (only `browser` has one) and its description. */
export function applyMcpConnectorDefaults(server: McpServerDefinition): McpServerDefinition {
  if (server.connector === undefined) {
    return server;
  }
  if (!isMcpConnectorKind(server.connector)) {
    throw new McpRegistryError(
      "INVALID_SERVER",
      `MCP server "${server.id}" connector must be one of ${MCP_CONNECTOR_KINDS.join(", ")}.`,
    );
  }
  const preset = MCP_CONNECTOR_PRESETS[server.connector];
  const launch =
    preset.launch !== undefined &&
    server.command === undefined &&
    server.url === undefined &&
    (server.transport === undefined || server.transport === preset.launch.transport)
      ? {
          transport: preset.launch.transport,
          command: preset.launch.command,
          args: [...preset.launch.args],
        }
      : {};
  return {
    ...server,
    ...launch,
    description: server.description ?? preset.description,
  };
}

export function normalizeMcpServer(input: McpServerDefinition): McpServerDefinition {
  const server = applyMcpConnectorDefaults(input);
  const id = assertNonEmpty(server.id, "server.id");

  if (!MCP_SERVER_ID_PATTERN.test(id)) {
    throw new McpRegistryError(
      "INVALID_ID",
      `MCP server id "${id}" must start with a letter or digit and use only letters, digits, "-", "_" or ".".`,
    );
  }

  if (server.transport !== "stdio" && server.transport !== "http" && server.transport !== "sse") {
    throw new McpRegistryError(
      "INVALID_SERVER",
      `MCP server "${id}" transport must be stdio, http or sse.`,
    );
  }

  if (server.transport === "stdio") {
    assertNonEmpty(server.command, `MCP server "${id}" command`);
  }

  if (
    server.timeoutMs !== undefined &&
    (!Number.isInteger(server.timeoutMs) || server.timeoutMs <= 0)
  ) {
    throw new McpRegistryError(
      "INVALID_SERVER",
      `MCP server "${id}" timeoutMs must be a positive integer.`,
    );
  }

  if (server.transport === "http" || server.transport === "sse") {
    assertNonEmpty(server.url, `MCP server "${id}" url`);
  }

  return Object.freeze({
    ...server,
    id,
    ...(server.command === undefined ? {} : { command: server.command.trim() }),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd.trim() }),
    ...(server.url === undefined ? {} : { url: server.url.trim() }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.roots === undefined ? {} : { roots: [...server.roots] }),
    ...(server.env === undefined ? {} : { env: { ...server.env } }),
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    ...(server.tools === undefined
      ? {}
      : {
          tools: {
            ...(server.tools.include === undefined ? {} : { include: [...server.tools.include] }),
            ...(server.tools.exclude === undefined ? {} : { exclude: [...server.tools.exclude] }),
          },
        }),
    ...(server.readOnlyTools === undefined ? {} : { readOnlyTools: [...server.readOnlyTools] }),
    ...(server.effects === undefined ? {} : { effects: [...server.effects] }),
    ...(server.toolEffects === undefined
      ? {}
      : {
          toolEffects: Object.fromEntries(
            Object.entries(server.toolEffects).map(([tool, effects]) => [tool, [...effects]]),
          ),
        }),
  });
}

export function createMcpRegistry(
  initialServers: readonly McpServerDefinition[] = [],
): McpRegistry {
  const servers = new Map<string, McpServerDefinition>();

  const registry: McpRegistry = {
    name,
    kind,
    register(server: McpServerDefinition): void {
      const normalized = normalizeMcpServer(server);

      if (servers.has(normalized.id)) {
        throw new McpRegistryError(
          "DUPLICATE_SERVER",
          `MCP server "${normalized.id}" has already been registered.`,
        );
      }

      servers.set(normalized.id, normalized);
    },
    get(id: string): McpServerDefinition | undefined {
      return servers.get(id);
    },
    list(): readonly McpServerDefinition[] {
      return [...servers.values()];
    },
    remove(id: string): boolean {
      return servers.delete(id);
    },
    resolveLaunch(
      id: string,
      envOverrides?: Readonly<Record<string, string>>,
    ): McpLaunchDefinition {
      const server = servers.get(id);

      if (!server) {
        throw new McpRegistryError("UNKNOWN_SERVER", `Unknown MCP server "${id}".`);
      }

      return Object.freeze({
        transport: server.transport,
        ...(server.command === undefined ? {} : { command: server.command }),
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        ...(server.url === undefined ? {} : { url: server.url }),
        ...(server.env === undefined && envOverrides === undefined
          ? {}
          : {
              env: {
                ...(server.env ?? {}),
                ...(envOverrides ?? {}),
              },
            }),
      });
    },
    describeForPrompt(): string {
      const lines = ["Available MCP servers:"];

      for (const server of servers.values()) {
        const location =
          server.transport === "stdio"
            ? `${server.command}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`
            : server.url;

        lines.push(
          `- ${server.id} (${server.transport}): ${server.description ?? "No description"}${location ? ` -> ${location}` : ""}`,
        );
      }

      return lines.join("\n");
    },
  };

  for (const server of initialServers) {
    registry.register(server);
  }

  return registry;
}
