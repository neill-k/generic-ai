export const name = "@generic-ai/plugin-mcp" as const;
export const kind = "mcp" as const;

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerDefinition {
  readonly id: string;
  readonly transport: McpTransport;
  readonly description?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly roots?: readonly string[];
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

function assertNonEmpty(value: string | undefined, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new McpRegistryError("INVALID_SERVER", `${label} must be a non-empty string.`);
}

function normalizeServer(server: McpServerDefinition): McpServerDefinition {
  const id = assertNonEmpty(server.id, "server.id");

  if (server.transport === "stdio") {
    assertNonEmpty(server.command, `MCP server "${id}" command`);
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
  });
}

export function createMcpRegistry(initialServers: readonly McpServerDefinition[] = []): McpRegistry {
  const servers = new Map<string, McpServerDefinition>();

  const registry: McpRegistry = {
    name,
    kind,
    register(server: McpServerDefinition): void {
      const normalized = normalizeServer(server);

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
    resolveLaunch(id: string, envOverrides?: Readonly<Record<string, string>>): McpLaunchDefinition {
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
