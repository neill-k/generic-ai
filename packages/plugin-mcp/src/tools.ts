import { createHash } from "node:crypto";

import {
  type AgentHarnessCapabilityEffect,
  type AgentHarnessEffectMetadata,
  createToolErrorEnvelope,
  GenericAIToolError,
  normalizeToolError,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";

import {
  isMcpDisconnectError,
  McpClientError,
  type McpCallToolResult,
  type McpClientManager,
  type McpToolInfo,
} from "./client.js";
import { classifyConnectorTool, OUTWARD_EFFECTS } from "./connectors.js";
import type { McpServerDefinition } from "./registry.js";

/** Effect for MCP tools that change state on the server. Only write-capable roles may call them. */
export const MCP_WRITE_EFFECT: AgentHarnessCapabilityEffect = "mcp.write";
/** Effect for MCP tools that only read. */
export const MCP_READ_EFFECT: AgentHarnessCapabilityEffect = "mcp.read";

const MAX_TOOL_NAME_LENGTH = 64;

export interface McpHarnessToolContent {
  readonly type: "text" | "image";
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

export interface McpHarnessToolDetails {
  readonly serverId: string;
  readonly toolName: string;
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export interface McpHarnessToolResult {
  readonly content: readonly McpHarnessToolContent[];
  readonly details: McpHarnessToolDetails;
}

/**
 * A pi-compatible tool (also accepted by the native runtime) that forwards to one MCP server tool.
 * It carries SDK effect metadata, so harness role policies decide which roles see it.
 */
export interface McpHarnessTool extends AgentHarnessEffectMetadata {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly mcp: {
    readonly serverId: string;
    readonly toolName: string;
    readonly readOnly: boolean;
  };
  execute(
    toolCallId: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<McpHarnessToolResult>;
}

export interface CreateMcpHarnessToolsOptions {
  /** Maximum characters of text returned to the model per call. Defaults to 50_000. */
  readonly maxOutputChars?: number;
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function mcpHarnessToolName(server: McpServerDefinition, toolName: string): string {
  const prefix = sanitizeToolName(server.toolPrefix ?? `mcp__${server.id}`);
  const full = `${prefix}__${sanitizeToolName(toolName)}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) {
    return full;
  }
  const hash = createHash("sha256")
    .update(`${server.id}\u0000${toolName}`)
    .digest("hex")
    .slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** The `toolEffects` entry for a tool: an exact name first, then the first matching `*` pattern. */
export function matchToolEffectsOverride(
  server: McpServerDefinition,
  toolName: string,
): readonly AgentHarnessCapabilityEffect[] | undefined {
  const overrides = server.toolEffects;
  if (overrides === undefined) {
    return undefined;
  }
  if (Object.hasOwn(overrides, toolName)) {
    return overrides[toolName];
  }
  for (const [pattern, effects] of Object.entries(overrides)) {
    if (pattern.includes("*") && globToRegExp(pattern).test(toolName)) {
      return effects;
    }
  }
  return undefined;
}

const NON_MUTATING_EFFECTS: ReadonlySet<AgentHarnessCapabilityEffect> = new Set([
  "mcp.read",
  "fs.read",
  "repo.inspect",
  "lsp.read",
  "memory.read",
  "handoff.read",
  "network.egress",
]);

function effectsAreReadOnly(effects: readonly AgentHarnessCapabilityEffect[]): boolean {
  return effects.every((effect) => NON_MUTATING_EFFECTS.has(effect));
}

function explicitlyReadOnly(server: McpServerDefinition, tool: McpToolInfo): boolean {
  return server.readOnly === true || server.readOnlyTools?.includes(tool.name) === true;
}

/**
 * Effects for one tool. Precedence: a `toolEffects` override, then `readOnly` / `readOnlyTools`,
 * then the server's `connector` classification, then the server's `readOnlyHint` annotation.
 * Server-wide `effects` are added to everything except an override.
 */
export function mcpToolEffects(
  server: McpServerDefinition,
  tool: McpToolInfo,
): readonly AgentHarnessCapabilityEffect[] {
  const override = matchToolEffectsOverride(server, tool.name);
  if (override !== undefined) {
    return Object.freeze([...new Set(override)]);
  }
  let base: readonly AgentHarnessCapabilityEffect[];
  if (explicitlyReadOnly(server, tool)) {
    base = [MCP_READ_EFFECT];
  } else if (server.connector !== undefined) {
    base = classifyConnectorTool(server.connector, tool, {
      ...(server.trustAnnotations === undefined
        ? {}
        : { trustAnnotations: server.trustAnnotations }),
    }).effects;
  } else if (server.trustAnnotations !== false && tool.annotations?.readOnlyHint === true) {
    base = [MCP_READ_EFFECT];
  } else {
    base = [MCP_READ_EFFECT, MCP_WRITE_EFFECT];
  }
  return Object.freeze([...new Set([...base, ...(server.effects ?? [])])]);
}

/** A tool is read-only when none of its effects change anything. */
export function isMcpToolReadOnly(server: McpServerDefinition, tool: McpToolInfo): boolean {
  return effectsAreReadOnly(mcpToolEffects(server, tool));
}

/** True when the tool sends messages, writes to an external system or spends money. */
export function isMcpToolOutward(server: McpServerDefinition, tool: McpToolInfo): boolean {
  return mcpToolEffects(server, tool).some((effect) => OUTWARD_EFFECTS.includes(effect));
}

function isToolIncluded(server: McpServerDefinition, toolName: string): boolean {
  const include = server.tools?.include;
  if (include !== undefined && !include.includes(toolName)) {
    return false;
  }
  return server.tools?.exclude?.includes(toolName) !== true;
}

function inputSchemaFor(tool: McpToolInfo): Record<string, unknown> {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (schema === undefined || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return { ...schema, type: "object", properties: schema["properties"] ?? {} };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[MCP output truncated: ${text.length - maxChars} more characters]`;
}

export function convertMcpToolResult(
  result: McpCallToolResult,
  maxOutputChars = 50_000,
): readonly McpHarnessToolContent[] {
  const content: McpHarnessToolContent[] = [];
  const texts: string[] = [];
  const flushText = () => {
    if (texts.length > 0) {
      content.push({ type: "text", text: truncate(texts.join("\n"), maxOutputChars) });
      texts.length = 0;
    }
  };

  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "image":
        flushText();
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "audio":
        texts.push(`[audio content: ${block.mimeType}]`);
        break;
      case "resource_link":
        texts.push(
          `[resource: ${block.name}${block.uri === undefined ? "" : ` <${block.uri}>`}${
            block.description === undefined ? "" : ` - ${block.description}`
          }]`,
        );
        break;
      case "resource": {
        const resource = block.resource as { uri: string; text?: string; mimeType?: string };
        texts.push(
          typeof resource.text === "string"
            ? `[resource ${resource.uri}]\n${resource.text}`
            : `[binary resource ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`,
        );
        break;
      }
      default:
        break;
    }
  }

  if (texts.length === 0 && content.length === 0 && result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  flushText();
  if (content.length === 0) {
    content.push({ type: "text", text: "(no output)" });
  }
  return Object.freeze(content);
}

function toolError(
  error: unknown,
  context: { readonly serverId: string; readonly toolName: string; readonly readOnly: boolean },
): GenericAIToolError {
  const metadata = { serverId: context.serverId, toolName: context.toolName };
  if (error instanceof GenericAIToolError) {
    return error;
  }
  if (isMcpDisconnectError(error) || error instanceof McpClientError) {
    const code = error instanceof McpClientError ? error.code : "DISCONNECTED";
    const unavailable = code !== "MISSING_ENV";
    return new GenericAIToolError(
      createToolErrorEnvelope({
        kind: unavailable ? "upstream_unavailable" : "auth_required",
        safeMessage: `MCP server "${context.serverId}" is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: unavailable,
        rawCause: error,
        remediationHints: [
          unavailable
            ? {
                kind: "retry",
                message: context.readOnly
                  ? "The client reconnects automatically; retry the call."
                  : "The client reconnects automatically. Check whether the previous call took effect before retrying, because it may have reached the server.",
              }
            : { kind: "request_auth", message: "Set the missing environment variable." },
        ],
        metadata,
      }),
      { cause: error },
    );
  }
  return new GenericAIToolError(normalizeToolError({ error, metadata }), { cause: error });
}

function createMcpHarnessTool(
  manager: McpClientManager,
  server: McpServerDefinition,
  tool: McpToolInfo,
  options: CreateMcpHarnessToolsOptions,
): McpHarnessTool {
  const effects = mcpToolEffects(server, tool);
  const readOnly = effectsAreReadOnly(effects);
  const outward = effects.some((effect) => OUTWARD_EFFECTS.includes(effect));
  const name = mcpHarnessToolName(server, tool.name);
  const label = tool.title ?? tool.annotations?.title ?? `${server.id}: ${tool.name}`;
  const description = [
    tool.description?.trim() || `MCP tool "${tool.name}".`,
    `(MCP server "${server.id}"${
      readOnly ? ", read-only" : outward ? ", outward action: may need owner approval" : ""
    })`,
  ].join(" ");
  const context = { serverId: server.id, toolName: tool.name, readOnly };

  const harnessTool = {
    name,
    label,
    description,
    parameters: inputSchemaFor(tool),
    mcp: Object.freeze({ serverId: server.id, toolName: tool.name, readOnly }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown> | undefined,
      signal?: AbortSignal,
    ): Promise<McpHarnessToolResult> {
      let result: McpCallToolResult;
      try {
        result = await manager.callTool(server.id, tool.name, params ?? {}, {
          ...(signal === undefined ? {} : { signal }),
          readOnly,
        });
      } catch (error) {
        throw toolError(error, context);
      }
      const content = convertMcpToolResult(result, options.maxOutputChars);
      if (result.isError === true) {
        const message = content
          .map((block) => block.text ?? "")
          .join("\n")
          .trim();
        throw new GenericAIToolError(
          createToolErrorEnvelope({
            kind: "unknown",
            safeMessage: message.length > 0 ? message : `MCP tool "${tool.name}" failed.`,
            retryable: false,
            metadata: { serverId: server.id, toolName: tool.name },
          }),
        );
      }
      return Object.freeze({
        content,
        details: Object.freeze({
          serverId: server.id,
          toolName: tool.name,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          isError: false,
        }),
      });
    },
  };

  return withAgentHarnessToolEffects(harnessTool, {
    id: `mcp.${server.id}.${tool.name}`,
    label,
    description,
    effects,
    reversibility: readOnly ? "reversible-cheap" : "irreversible",
    retrySemantics:
      readOnly || tool.annotations?.idempotentHint === true
        ? "safe-to-retry"
        : "retry-may-duplicate",
    metadata: {
      mcpServer: server.id,
      mcpTool: tool.name,
      transport: server.transport,
      ...(server.connector === undefined ? {} : { connector: server.connector }),
      outward,
      ...(tool.annotations?.destructiveHint === undefined
        ? {}
        : { destructiveHint: tool.annotations.destructiveHint }),
      ...(tool.annotations?.openWorldHint === undefined
        ? {}
        : { openWorldHint: tool.annotations.openWorldHint }),
    },
  }) as McpHarnessTool;
}

/**
 * Turn every tool of every connected server into a harness tool. Servers that fail to connect are
 * left out unless they are `required`. Tool names are `mcp__<server>__<tool>` (or the server's
 * `toolPrefix`), sanitized and capped at 64 characters.
 */
export async function createMcpHarnessTools(
  manager: McpClientManager,
  options: CreateMcpHarnessToolsOptions = {},
): Promise<readonly McpHarnessTool[]> {
  const listed = await manager.listTools();
  const tools: McpHarnessTool[] = [];
  const names = new Set<string>();
  for (const { serverId, tool } of listed) {
    const server = manager.get(serverId);
    if (server === undefined || !isToolIncluded(server, tool.name)) {
      continue;
    }
    const harnessTool = createMcpHarnessTool(manager, server, tool, options);
    if (names.has(harnessTool.name)) {
      throw new McpClientError(
        "CONNECT_FAILED",
        `MCP tool name "${harnessTool.name}" is used twice; set a distinct toolPrefix on server "${serverId}".`,
        serverId,
      );
    }
    names.add(harnessTool.name);
    tools.push(harnessTool);
  }
  return Object.freeze(tools);
}
