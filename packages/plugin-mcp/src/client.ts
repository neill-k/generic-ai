import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createMcpRegistry,
  type McpLaunchDefinition,
  type McpRegistry,
  type McpServerDefinition,
} from "./registry.js";

export type McpToolInfo = Tool;
export type McpCallToolResult = CallToolResult;

export type McpConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "disabled"
  | "closed";

export interface McpReconnectOptions {
  /** Automatic reconnect attempts after a dropped connection. Defaults to 5. */
  readonly maxAttempts?: number;
  /** First backoff delay in milliseconds. Defaults to 250. */
  readonly initialDelayMs?: number;
  /** Backoff ceiling in milliseconds. Defaults to 10_000. */
  readonly maxDelayMs?: number;
}

/**
 * What to do when a tool call fails because the connection dropped mid-call. A dropped call may or
 * may not have reached the server, so a retry can repeat a write. Defaults to `"read-only"`.
 */
export type McpRetryOnDisconnect = "never" | "read-only" | "always";

export interface McpServerStatus {
  readonly id: string;
  readonly transport: McpServerDefinition["transport"];
  readonly state: McpConnectionState;
  readonly toolCount: number;
  readonly connectCount: number;
  readonly lastError?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export interface McpClientLike {
  connect(transport: Transport, options?: { readonly timeout?: number }): Promise<void>;
  close(): Promise<void>;
  listTools(
    params?: { readonly cursor?: string },
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<{ readonly tools: readonly Tool[]; readonly nextCursor?: string | undefined }>;
  callTool(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<unknown>;
  getServerVersion(): { readonly name: string; readonly version: string } | undefined;
  setNotificationHandler: Client["setNotificationHandler"];
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

export interface McpTransportFactoryInput {
  readonly server: McpServerDefinition;
  readonly launch: McpLaunchDefinition;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpClientManagerOptions {
  readonly servers: readonly McpServerDefinition[];
  /** Client identity sent during initialization. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** Default per-request timeout in milliseconds. Defaults to 60_000. */
  readonly timeoutMs?: number;
  /** Connect and initialization timeout in milliseconds. Defaults to 30_000. */
  readonly connectTimeoutMs?: number;
  readonly reconnect?: McpReconnectOptions;
  readonly retryOnDisconnect?: McpRetryOnDisconnect;
  /** Environment used to resolve `${VAR}` placeholders. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: replace transport construction. */
  readonly createTransport?: (input: McpTransportFactoryInput) => Transport;
  /** Test seam: replace client construction. */
  readonly createClient?: (server: McpServerDefinition) => McpClientLike;
  /** Receives connection lifecycle and server stderr lines. */
  readonly onEvent?: (event: McpClientEvent) => void;
}

export type McpClientEvent =
  | { readonly type: "connected"; readonly serverId: string; readonly attempt: number }
  | { readonly type: "disconnected"; readonly serverId: string; readonly reason?: string }
  | {
      readonly type: "reconnect_scheduled";
      readonly serverId: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly type: "connect_failed"; readonly serverId: string; readonly error: string }
  | { readonly type: "tools_changed"; readonly serverId: string; readonly toolCount: number }
  | { readonly type: "stderr"; readonly serverId: string; readonly line: string };

export interface McpCallToolOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Whether the caller considers this call safe to retry after a dropped connection. */
  readonly readOnly?: boolean;
}

export type McpClientErrorCode =
  | "UNKNOWN_SERVER"
  | "SERVER_DISABLED"
  | "CONNECT_FAILED"
  | "DISCONNECTED"
  | "MISSING_ENV"
  | "CLOSED";

export class McpClientError extends Error {
  constructor(
    public readonly code: McpClientErrorCode,
    message: string,
    public readonly serverId?: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "McpClientError";
  }
}

export interface McpClientManager extends McpRegistry {
  /** Connect every enabled server. Failures of optional servers are recorded, not thrown. */
  connect(): Promise<readonly McpServerStatus[]>;
  /** Tools of every connected server, connecting lazily. Optional servers that fail are skipped. */
  listTools(): Promise<readonly { readonly serverId: string; readonly tool: McpToolInfo }[]>;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: McpCallToolOptions,
  ): Promise<McpCallToolResult>;
  status(): readonly McpServerStatus[];
  /** Close every connection. Pending reconnects are cancelled; later calls fail with CLOSED. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT: Required<McpReconnectOptions> = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
};
const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveMcpPlaceholders(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  context: { readonly serverId: string; readonly field: string },
): string {
  return value.replace(PLACEHOLDER_PATTERN, (_match, variable: string) => {
    const resolved = env[variable];
    if (resolved === undefined) {
      throw new McpClientError(
        "MISSING_ENV",
        `MCP server "${context.serverId}" ${context.field} references \${${variable}}, which is not set.`,
        context.serverId,
      );
    }
    return resolved;
  });
}

function resolveRecord(
  record: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
  serverId: string,
  field: string,
): Record<string, string> | undefined {
  if (record === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      resolveMcpPlaceholders(value, env, { serverId, field: `${field}.${key}` }),
    ]),
  );
}

/** Errors that mean the connection is gone, so the client must reconnect before the next call. */
export function isMcpDisconnectError(error: unknown): boolean {
  if (error instanceof McpError) {
    return error.code === ErrorCode.ConnectionClosed;
  }
  if (error instanceof StreamableHTTPError) {
    // 404 means the server forgot our session, typically after a restart.
    return error.code === 404 || error.code === undefined;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ERR_STREAM_DESTROYED"
    ) {
      return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error && isMcpDisconnectError(cause)) {
      return true;
    }
    return /not connected|connection closed|fetch failed|socket hang up/i.test(error.message);
  }
  return false;
}

function defaultCreateTransport(input: McpTransportFactoryInput): Transport {
  const { launch, server } = input;
  if (launch.transport === "stdio") {
    if (launch.command === undefined) {
      throw new McpClientError(
        "CONNECT_FAILED",
        `MCP server "${server.id}" has no command.`,
        server.id,
      );
    }
    return new StdioClientTransport({
      command: launch.command,
      ...(launch.args === undefined ? {} : { args: [...launch.args] }),
      env: { ...getDefaultEnvironment(), ...(launch.env ?? {}) },
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      stderr: "pipe",
    });
  }

  if (launch.url === undefined) {
    throw new McpClientError("CONNECT_FAILED", `MCP server "${server.id}" has no url.`, server.id);
  }
  const url = new URL(launch.url);
  const requestInit = input.headers === undefined ? undefined : { headers: { ...input.headers } };
  if (launch.transport === "sse") {
    return new SSEClientTransport(url, {
      ...(requestInit === undefined ? {} : { requestInit }),
      ...(input.headers === undefined
        ? {}
        : {
            eventSourceInit: {
              fetch: (resource, init) =>
                fetch(resource, {
                  ...init,
                  headers: { ...(init?.headers as Record<string, string>), ...input.headers },
                }),
            },
          }),
    });
  }
  return new StreamableHTTPClientTransport(url, requestInit === undefined ? {} : { requestInit });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ConnectionOptions {
  readonly server: McpServerDefinition;
  readonly registry: McpRegistry;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly reconnect: Required<McpReconnectOptions>;
  readonly retryOnDisconnect: McpRetryOnDisconnect;
  readonly createTransport: (input: McpTransportFactoryInput) => Transport;
  readonly createClient: (server: McpServerDefinition) => McpClientLike;
  readonly emit: (event: McpClientEvent) => void;
}

/**
 * One server connection. It connects lazily, reconnects with exponential backoff when the
 * transport closes, and refreshes its tool list when the server announces a change.
 */
class McpServerConnection {
  private state: McpConnectionState;
  private client: McpClientLike | undefined;
  private tools: readonly Tool[] = [];
  private connecting: Promise<void> | undefined;
  private lastError: string | undefined;
  private connectCount = 0;
  private generation = 0;
  private serverVersion: { readonly name: string; readonly version: string } | undefined;
  private readonly closed = new AbortController();

  constructor(private readonly options: ConnectionOptions) {
    this.state = options.server.enabled === false ? "disabled" : "idle";
  }

  private isClosed(): boolean {
    return this.closed.signal.aborted;
  }

  get id(): string {
    return this.options.server.id;
  }

  status(): McpServerStatus {
    return Object.freeze({
      id: this.id,
      transport: this.options.server.transport,
      state: this.state,
      toolCount: this.tools.length,
      connectCount: this.connectCount,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.serverVersion === undefined
        ? {}
        : { serverName: this.serverVersion.name, serverVersion: this.serverVersion.version }),
    });
  }

  async ensureConnected(): Promise<McpClientLike> {
    if (this.state === "disabled") {
      throw new McpClientError("SERVER_DISABLED", `MCP server "${this.id}" is disabled.`, this.id);
    }
    if (this.isClosed()) {
      throw new McpClientError("CLOSED", "MCP client manager is closed.", this.id);
    }
    if (this.state === "connected" && this.client !== undefined) {
      return this.client;
    }
    if (this.connecting === undefined) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
    if (this.client === undefined || this.state !== "connected") {
      throw new McpClientError(
        "DISCONNECTED",
        `MCP server "${this.id}" is not connected${this.lastError ? `: ${this.lastError}` : "."}`,
        this.id,
      );
    }
    return this.client;
  }

  async listTools(): Promise<readonly Tool[]> {
    await this.ensureConnected();
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    options: McpCallToolOptions,
  ): Promise<CallToolResult> {
    const attempt = async (): Promise<CallToolResult> => {
      const client = await this.ensureConnected();
      const generation = this.generation;
      try {
        return (await client.callTool(
          { name: toolName, ...(args === undefined ? {} : { arguments: args }) },
          undefined,
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            timeout: options.timeoutMs ?? this.options.server.timeoutMs ?? this.options.timeoutMs,
          },
        )) as CallToolResult;
      } catch (error) {
        if (isMcpDisconnectError(error) && !options.signal?.aborted) {
          this.markDisconnected(generation, errorMessage(error));
        }
        throw error;
      }
    };

    try {
      return await attempt();
    } catch (error) {
      const retry =
        this.options.retryOnDisconnect === "always" ||
        (this.options.retryOnDisconnect === "read-only" && options.readOnly === true);
      if (!retry || options.signal?.aborted || !isMcpDisconnectError(error)) {
        throw error;
      }
      return attempt();
    }
  }

  async close(): Promise<void> {
    this.state = "closed";
    this.closed.abort();
    const client = this.client;
    this.client = undefined;
    this.generation += 1;
    if (client !== undefined) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.isClosed()) {
      return;
    }
    const previous = this.client;
    this.client = undefined;
    if (previous !== undefined) {
      previous.onclose = undefined;
      await previous.close().catch(() => undefined);
    }

    this.state = this.connectCount === 0 ? "connecting" : "reconnecting";
    const { server } = this.options;
    let client: McpClientLike | undefined;
    try {
      const launch = this.resolveLaunch();
      const headers = resolveRecord(server.headers, this.options.env, server.id, "headers");
      const transport = this.options.createTransport({
        server,
        launch,
        ...(headers === undefined ? {} : { headers }),
      });
      this.pipeStderr(transport);
      client = this.options.createClient(server);
      await client.connect(transport, { timeout: this.options.connectTimeoutMs });
      if (this.isClosed()) {
        await client.close().catch(() => undefined);
        return;
      }
      const tools = await this.fetchTools(client);

      this.generation += 1;
      const generation = this.generation;
      this.client = client;
      this.tools = tools;
      this.serverVersion = client.getServerVersion();
      this.connectCount += 1;
      this.lastError = undefined;
      this.state = "connected";

      client.onclose = () => this.markDisconnected(generation, "transport closed");
      client.onerror = (error) => {
        this.lastError = errorMessage(error);
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (this.generation !== generation || this.client === undefined) {
          return;
        }
        try {
          this.tools = await this.fetchTools(this.client);
          this.options.emit({
            type: "tools_changed",
            serverId: this.id,
            toolCount: this.tools.length,
          });
        } catch (error) {
          this.lastError = errorMessage(error);
        }
      });
      this.options.emit({ type: "connected", serverId: this.id, attempt: this.connectCount });
    } catch (error) {
      if (client !== undefined) {
        client.onclose = undefined;
        await client.close().catch(() => undefined);
      }
      this.lastError = errorMessage(error);
      if (!this.isClosed()) {
        this.state = "failed";
      }
      this.options.emit({ type: "connect_failed", serverId: this.id, error: this.lastError });
      if (error instanceof McpClientError) {
        throw error;
      }
      throw new McpClientError(
        "CONNECT_FAILED",
        `Could not connect to MCP server "${this.id}": ${this.lastError}`,
        this.id,
        { cause: error },
      );
    }
  }

  private resolveLaunch(): McpLaunchDefinition {
    const { server, env } = this.options;
    const launch = this.options.registry.resolveLaunch(server.id);
    const resolvedEnv = resolveRecord(launch.env, env, server.id, "env");
    return Object.freeze({
      transport: launch.transport,
      ...(launch.command === undefined
        ? {}
        : {
            command: resolveMcpPlaceholders(launch.command, env, {
              serverId: server.id,
              field: "command",
            }),
          }),
      ...(launch.args === undefined
        ? {}
        : {
            args: launch.args.map((arg, index) =>
              resolveMcpPlaceholders(arg, env, { serverId: server.id, field: `args[${index}]` }),
            ),
          }),
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      ...(launch.url === undefined
        ? {}
        : { url: resolveMcpPlaceholders(launch.url, env, { serverId: server.id, field: "url" }) }),
      ...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
    });
  }

  private pipeStderr(transport: Transport): void {
    const stderr = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (stderr === null || stderr === undefined) {
      return;
    }
    let buffer = "";
    stderr.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          this.options.emit({ type: "stderr", serverId: this.id, line });
        }
        newline = buffer.indexOf("\n");
      }
    });
  }

  private async fetchTools(client: McpClientLike): Promise<readonly Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: this.options.timeoutMs,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
    return Object.freeze(tools);
  }

  private markDisconnected(generation: number, reason: string): void {
    if (generation !== this.generation || this.isClosed()) {
      return;
    }
    this.generation += 1;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) {
      client.onclose = undefined;
      void client.close().catch(() => undefined);
    }
    this.state = "reconnecting";
    this.lastError = reason;
    this.options.emit({ type: "disconnected", serverId: this.id, reason });
    if (this.connecting === undefined) {
      this.connecting = this.reconnectWithBackoff().finally(() => {
        this.connecting = undefined;
      });
      // Errors are reported through state and lastError; callers awaiting ensureConnected see them.
      this.connecting.catch(() => undefined);
    }
  }

  private async reconnectWithBackoff(): Promise<void> {
    const { maxAttempts, initialDelayMs, maxDelayMs } = this.options.reconnect;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      this.options.emit({ type: "reconnect_scheduled", serverId: this.id, attempt, delayMs });
      await sleep(delayMs, this.closed.signal);
      if (this.isClosed()) {
        return;
      }
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.isClosed()) {
      this.state = "failed";
    }
    throw lastError ?? new McpClientError("DISCONNECTED", `MCP server "${this.id}" is gone.`);
  }
}

/**
 * Create a client manager for the configured MCP servers. Connections open lazily on first use
 * (or eagerly with `connect()`), drop into backoff reconnects when a transport closes, and
 * reconnect on demand after reconnects are exhausted.
 *
 * The manager is also an {@link McpRegistry}, so it can be bound as the harness `mcp` capability.
 */
export function createMcpClientManager(options: McpClientManagerOptions): McpClientManager {
  const registry = createMcpRegistry(options.servers);
  const env = options.env ?? process.env;
  const clientInfo = options.clientInfo ?? { name: "generic-ai", version: "0.0.0" };
  const createClient =
    options.createClient ??
    (() =>
      new Client(
        { name: clientInfo.name, version: clientInfo.version },
        { capabilities: {} },
      ) as unknown as McpClientLike);
  const emit = (event: McpClientEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Event sinks must not break connections.
    }
  };
  const connections = new Map<string, McpServerConnection>();
  for (const server of registry.list()) {
    connections.set(
      server.id,
      new McpServerConnection({
        server,
        registry,
        env,
        clientInfo,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        reconnect: { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) },
        retryOnDisconnect: options.retryOnDisconnect ?? "read-only",
        createTransport: options.createTransport ?? defaultCreateTransport,
        createClient,
        emit,
      }),
    );
  }
  let closed = false;

  const connectionFor = (serverId: string): McpServerConnection => {
    const connection = connections.get(serverId);
    if (connection === undefined) {
      throw new McpClientError("UNKNOWN_SERVER", `Unknown MCP server "${serverId}".`, serverId);
    }
    return connection;
  };

  const enabledConnections = () =>
    [...connections.values()].filter((connection) => connection.status().state !== "disabled");

  const connectAll = async (): Promise<void> => {
    const results = await Promise.allSettled(
      enabledConnections().map((connection) => connection.ensureConnected()),
    );
    const enabled = enabledConnections();
    results.forEach((result, index) => {
      const connection = enabled[index];
      if (
        result.status === "rejected" &&
        connection !== undefined &&
        registry.get(connection.id)?.required === true
      ) {
        throw result.reason;
      }
    });
  };

  const manager: McpClientManager = {
    ...registry,
    register(): void {
      throw new McpClientError(
        "CLOSED",
        "Servers cannot be added to a running MCP client manager; create a new manager instead.",
      );
    },
    remove(): boolean {
      throw new McpClientError(
        "CLOSED",
        "Servers cannot be removed from a running MCP client manager; set enabled: false instead.",
      );
    },
    describeForPrompt(): string {
      const lines = ["Available MCP servers:"];
      for (const server of registry.list()) {
        const status = connections.get(server.id)?.status();
        lines.push(
          `- ${server.id} (${server.transport}${
            server.connector === undefined ? "" : `, ${server.connector} connector`
          }, ${status?.state ?? "idle"}${
            status !== undefined && status.toolCount > 0 ? `, ${status.toolCount} tools` : ""
          }): ${server.description ?? "No description"}`,
        );
      }
      return lines.join("\n");
    },
    async connect() {
      if (closed) {
        throw new McpClientError("CLOSED", "MCP client manager is closed.");
      }
      await connectAll();
      return manager.status();
    },
    async listTools() {
      if (closed) {
        throw new McpClientError("CLOSED", "MCP client manager is closed.");
      }
      await connectAll();
      const result: { readonly serverId: string; readonly tool: Tool }[] = [];
      for (const connection of enabledConnections()) {
        if (connection.status().state !== "connected") {
          continue;
        }
        const tools = await connection.listTools().catch((error: unknown) => {
          if (registry.get(connection.id)?.required === true) {
            throw error;
          }
          return [] as readonly Tool[];
        });
        for (const tool of tools) {
          result.push({ serverId: connection.id, tool });
        }
      }
      return Object.freeze(result);
    },
    async callTool(serverId, toolName, args, callOptions = {}) {
      if (closed) {
        throw new McpClientError("CLOSED", "MCP client manager is closed.", serverId);
      }
      return connectionFor(serverId).callTool(toolName, args, callOptions);
    },
    status() {
      return Object.freeze([...connections.values()].map((connection) => connection.status()));
    },
    async close() {
      closed = true;
      await Promise.all([...connections.values()].map((connection) => connection.close()));
    },
  };

  return manager;
}
