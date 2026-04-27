import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { defineTool, withAgentHarnessToolEffects, type ToolDefinition } from "@generic-ai/sdk";
import {
  createWorkspaceLayout,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";
import { Type } from "@sinclair/typebox";

export const name = "@generic-ai/plugin-lsp" as const;
export const kind = "lsp" as const;

export interface LspServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly languages?: readonly string[];
}

export interface LspClient {
  request(serverId: string, method: string, params: unknown): Promise<unknown>;
  dispose?(): Promise<void> | void;
}

export interface StdioLspClientOptions {
  readonly root: WorkspaceRootInput;
  readonly servers: readonly LspServerConfig[];
  readonly timeoutMs?: number;
}

export interface LspPluginOptions {
  readonly root: WorkspaceRootInput;
  readonly servers?: readonly LspServerConfig[];
  readonly client?: LspClient;
  readonly timeoutMs?: number;
}

export interface LspPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly servers: readonly LspServerConfig[];
  readonly tool: ToolDefinition;
  request(serverId: string, method: string, params: unknown): Promise<unknown>;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
  readonly method?: string;
  readonly params?: unknown;
}

function serverSummary(server: LspServerConfig): Record<string, unknown> {
  return {
    id: server.id,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd,
    languages: server.languages ?? [],
  };
}

function defaultServerId(servers: readonly LspServerConfig[], requested?: string): string {
  if (requested && requested.trim().length > 0) {
    return requested;
  }

  const first = servers[0];
  if (first === undefined) {
    throw new Error("No LSP servers are configured.");
  }

  return first.id;
}

function frameMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function tryReadMessage(
  buffer: Buffer,
): { readonly message: JsonRpcResponse; readonly rest: Buffer } | undefined {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return undefined;
  }

  const headers = buffer.subarray(0, headerEnd).toString("utf8");
  const match = /Content-Length:\s*(\d+)/i.exec(headers);
  if (!match) {
    throw new Error("LSP server emitted a message without Content-Length.");
  }

  const bodyLength = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + bodyLength;
  if (buffer.length < bodyEnd) {
    return undefined;
  }

  const raw = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  return {
    message: JSON.parse(raw) as JsonRpcResponse,
    rest: buffer.subarray(bodyEnd),
  };
}

function write(
  process: ChildProcessWithoutNullStreams,
  message: JsonRpcRequest | JsonRpcNotification,
): void {
  process.stdin.write(frameMessage(message));
}

function waitForResponse(input: {
  readonly process: ChildProcessWithoutNullStreams;
  readonly id: number;
  readonly timeoutMs: number;
}): Promise<JsonRpcResponse> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for LSP response ${input.id}.`));
    }, input.timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      input.process.stdout.off("data", onData);
      input.process.stderr.off("data", onStderr);
      input.process.off("error", onError);
      input.process.off("exit", onExit);
    }

    function onData(chunk: Buffer): void {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const parsed = tryReadMessage(buffer);
          if (parsed === undefined) {
            return;
          }

          buffer = parsed.rest;
          if (parsed.message.id === input.id) {
            cleanup();
            resolve(parsed.message);
            return;
          }
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    function onStderr(chunk: Buffer): void {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        // stderr is common for language-server diagnostics, so keep it non-fatal.
      }
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onExit(code: number | null): void {
      cleanup();
      reject(new Error(`LSP server exited before response ${input.id} (code ${code}).`));
    }

    input.process.stdout.on("data", onData);
    input.process.stderr.on("data", onStderr);
    input.process.on("error", onError);
    input.process.on("exit", onExit);
  });
}

export function createStdioLspClient(options: StdioLspClientOptions): LspClient {
  const layout = createWorkspaceLayout(options.root);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const serversById = new Map(options.servers.map((server) => [server.id, server]));

  return Object.freeze({
    async request(serverId: string, method: string, params: unknown): Promise<unknown> {
      const server = serversById.get(serverId);
      if (server === undefined) {
        throw new Error(`Unknown LSP server "${serverId}".`);
      }

      const child = spawn(server.command, [...(server.args ?? [])], {
        cwd: server.cwd ?? layout.root,
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: "pipe",
      });

      try {
        write(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            processId: process.pid,
            rootUri: pathToFileURL(layout.root).href,
            capabilities: {},
          },
        });
        const initialized = await waitForResponse({ process: child, id: 1, timeoutMs });
        if (initialized.error) {
          throw new Error(initialized.error.message ?? "LSP initialize failed.");
        }

        write(child, {
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        });
        write(child, {
          jsonrpc: "2.0",
          id: 2,
          method,
          params,
        });
        const response = await waitForResponse({ process: child, id: 2, timeoutMs });
        if (response.error) {
          throw new Error(response.error.message ?? `LSP request ${method} failed.`);
        }

        return response.result;
      } finally {
        child.kill();
      }
    },
  });
}

async function textDocumentParams(
  root: string,
  documentPath: string,
): Promise<{ readonly uri: string }> {
  return {
    uri: pathToFileURL(await resolveSafeWorkspacePath(root, documentPath)).href,
  };
}

async function readDocument(root: string, documentPath: string): Promise<string> {
  return readFile(await resolveSafeWorkspacePath(root, documentPath), "utf8");
}

export function createLspPlugin(options: LspPluginOptions): LspPlugin {
  const layout = createWorkspaceLayout(options.root);
  const servers = Object.freeze([...(options.servers ?? [])]);
  const client =
    options.client ??
    createStdioLspClient({
      root: layout.root,
      servers,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

  async function request(serverId: string, method: string, params: unknown): Promise<unknown> {
    return client.request(serverId, method, params);
  }

  const tool = withAgentHarnessToolEffects(
    defineTool({
      name: "lsp",
      label: "LSP",
      description: "Inspect language server diagnostics, symbols, definitions, and references.",
      promptSnippet: "query language-server diagnostics and symbols",
      promptGuidelines: [
        "Use lsp for precise diagnostics, symbols, definitions, and references after repo orientation.",
      ],
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("servers"),
          Type.Literal("diagnostics"),
          Type.Literal("document-symbols"),
          Type.Literal("definition"),
          Type.Literal("references"),
        ]),
        serverId: Type.Optional(Type.String()),
        documentPath: Type.Optional(Type.String()),
        line: Type.Optional(Type.Integer({ minimum: 0 })),
        character: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(
        _toolCallId,
        params,
      ): Promise<{
        content: { type: "text"; text: string }[];
        readonly details: Record<string, unknown>;
      }> {
        if (params.action === "servers") {
          return {
            content: [{ type: "text" as const, text: `Found ${servers.length} LSP servers.` }],
            details: { servers: servers.map(serverSummary) },
          };
        }

        const serverId = defaultServerId(servers, params.serverId);
        const documentPath = params.documentPath;
        if (documentPath === undefined || documentPath.trim().length === 0) {
          throw new Error("documentPath is required for LSP document actions.");
        }

        const textDocument = await textDocumentParams(layout.root, documentPath);
        const documentText = await readDocument(layout.root, documentPath);
        const position =
          params.line === undefined || params.character === undefined
            ? undefined
            : { line: params.line, character: params.character };

        const result = await (async () => {
          switch (params.action) {
            case "diagnostics":
              return request(serverId, "textDocument/diagnostic", {
                textDocument,
                identifier: documentPath,
                previousResultId: null,
              });
            case "document-symbols":
              return request(serverId, "textDocument/documentSymbol", { textDocument });
            case "definition":
              if (position === undefined) {
                throw new Error("line and character are required for definition.");
              }
              return request(serverId, "textDocument/definition", {
                textDocument,
                position,
              });
            case "references":
              if (position === undefined) {
                throw new Error("line and character are required for references.");
              }
              return request(serverId, "textDocument/references", {
                textDocument,
                position,
                context: { includeDeclaration: true },
              });
            default:
              throw new Error(`Unsupported LSP action "${params.action}".`);
          }
        })();

        return {
          content: [{ type: "text" as const, text: `LSP ${params.action} completed.` }],
          details: {
            action: params.action,
            serverId,
            documentPath,
            documentLineCount: documentText.split(/\r?\n/).length,
            result,
          },
        };
      },
    }),
    ["lsp.read", "fs.read", "process.spawn"],
  );

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    servers,
    tool,
    request,
  });
}
