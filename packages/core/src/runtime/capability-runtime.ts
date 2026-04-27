import { randomUUID } from "node:crypto";
import type { RunEnvelope, RunEnvelopeMode } from "@generic-ai/sdk";
import {
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  DefaultResourceLoader,
  defineTool,
  withAgentHarnessToolEffects,
  type PromptOptions,
  type ToolDefinition,
} from "@generic-ai/sdk";
import { getAgentDir, type ResourceDiagnostic, type Skill } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  type CanonicalEvent,
  type CanonicalEventStream,
  createCanonicalEventStream,
  createPluginEvent,
} from "../events/index.js";
import { createRunEnvelope } from "../run-envelope/index.js";
import { createPiAgentSession, type PiRuntimeFactories } from "./pi.js";

const PI_RUNTIME_EVENT_PLUGIN_ID = "generic-ai-runtime";

type PiRuntimeTool =
  | ToolDefinition
  | {
      readonly name: string;
      readonly label?: string;
      readonly description: string;
      readonly parameters?: unknown;
      readonly execute: (...args: never[]) => unknown;
    };

export interface PiCapabilityFileTools {
  readonly piTools: readonly PiRuntimeTool[];
}

export interface PiCapabilityTerminalTools {
  readonly tool: PiRuntimeTool;
}

export interface PiCapabilitySkillsSnapshot {
  readonly skills: readonly Skill[];
  readonly diagnostics: readonly ResourceDiagnostic[];
  readonly prompt: string;
}

export interface PiCapabilitySkills {
  load(): Promise<PiCapabilitySkillsSnapshot>;
}

export interface PiCapabilityMcpServer {
  readonly id: string;
  readonly transport: string;
  readonly description?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly roots?: readonly string[];
}

export interface PiCapabilityMcpLaunchDefinition {
  readonly transport: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
}

export interface PiCapabilityMcp {
  list(): readonly PiCapabilityMcpServer[];
  get(id: string): PiCapabilityMcpServer | undefined;
  resolveLaunch(
    id: string,
    envOverrides?: Readonly<Record<string, string>>,
  ): PiCapabilityMcpLaunchDefinition;
  describeForPrompt(): string;
}

export interface PiCapabilityAgentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject?: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PiCapabilityMessageSearchResult {
  readonly message: PiCapabilityAgentMessage;
  readonly score: number;
  readonly matches: readonly string[];
}

export interface PiCapabilityMessaging {
  send(input: {
    readonly id?: string;
    readonly threadId?: string;
    readonly from: string;
    readonly to: string;
    readonly subject?: string;
    readonly body: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): PiCapabilityAgentMessage;
  inbox(
    agentId: string,
    options?: {
      readonly unreadOnly?: boolean;
      readonly limit?: number;
    },
  ): readonly PiCapabilityAgentMessage[];
  thread(threadId: string): readonly PiCapabilityAgentMessage[];
  markRead(messageId: string): PiCapabilityAgentMessage | undefined;
  search(
    agentId: string,
    query: string,
    limit?: number,
  ): readonly PiCapabilityMessageSearchResult[];
}

export interface PiCapabilityMemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PiCapabilityMemorySearchResult {
  readonly entry: PiCapabilityMemoryEntry;
  readonly score: number;
  readonly matches: readonly string[];
}

export interface PiCapabilityMemory {
  remember(
    agentId: string,
    entry: {
      readonly id?: string;
      readonly text: string;
      readonly tags?: readonly string[];
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
  ): Promise<PiCapabilityMemoryEntry>;
  get(agentId: string, id: string): Promise<PiCapabilityMemoryEntry | undefined>;
  list(agentId: string): Promise<readonly PiCapabilityMemoryEntry[]>;
  search(
    agentId: string,
    query: string,
    limit?: number,
  ): Promise<readonly PiCapabilityMemorySearchResult[]>;
  forget(agentId: string, id: string): Promise<boolean>;
}

export interface PiCapabilityBindings {
  readonly terminalTools?: PiCapabilityTerminalTools;
  readonly fileTools?: PiCapabilityFileTools;
  readonly customTools?: readonly ToolDefinition[];
  readonly mcp?: PiCapabilityMcp;
  readonly skills?: PiCapabilitySkills;
  readonly messaging?: PiCapabilityMessaging;
  readonly memory?: PiCapabilityMemory;
}

export type PiCapabilityResourceLoaderOptions = Omit<
  NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]>,
  "cwd" | "agentDir" | "settingsManager"
>;

export interface PiCapabilityToolRegistry {
  readonly tools: readonly PiRuntimeTool[];
  readonly customTools: readonly ToolDefinition[];
  readonly toolNames: readonly string[];
  readonly skillSnapshot?: PiCapabilitySkillsSnapshot;
}

export interface CreateCapabilityPiAgentSessionOptions
  extends Omit<CreateAgentSessionOptions, "tools" | "customTools" | "resourceLoader"> {
  readonly capabilities: PiCapabilityBindings;
  readonly resourceLoaderOptions?: PiCapabilityResourceLoaderOptions;
}

export interface CreateCapabilityPiAgentSessionResult extends CreateAgentSessionResult {
  readonly toolRegistry: PiCapabilityToolRegistry;
}

export interface RunCapabilityPiAgentSessionOptions extends CreateCapabilityPiAgentSessionOptions {
  readonly prompt: string;
  readonly promptOptions?: PromptOptions;
  readonly runId?: string;
  readonly rootScopeId?: string;
  readonly rootAgentId?: string;
  readonly mode?: RunEnvelopeMode;
  readonly eventStream?: CanonicalEventStream;
}

export interface RunCapabilityPiAgentSessionResult extends CreateCapabilityPiAgentSessionResult {
  readonly envelope: RunEnvelope;
  readonly eventStream: CanonicalEventStream;
  readonly events: readonly CanonicalEvent[];
  readonly failureMessage?: string;
}

function requireString(value: string | undefined, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new Error(`${label} is required.`);
}

function summarizeNames(names: readonly string[], singular: string, plural: string): string {
  if (names.length === 0) {
    return `No ${plural} found.`;
  }

  if (names.length === 1) {
    return `Found 1 ${singular}: ${names[0]}.`;
  }

  return `Found ${names.length} ${plural}: ${names.join(", ")}.`;
}

function createTextResult(summary: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: summary }],
    details,
  };
}

function redactEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) {
    return undefined;
  }

  const redacted: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    redacted[key] = "[REDACTED]";
  }
  return redacted;
}

function redactMcpServer<T extends { readonly env?: Readonly<Record<string, string>> }>(
  server: T,
): T {
  return { ...server, env: redactEnv(server.env) } as T;
}

function createMcpRegistryTool(capability: PiCapabilityMcp): ToolDefinition {
  return withAgentHarnessToolEffects(
    defineTool({
      name: "mcp_registry",
      label: "MCP Registry",
      description: "Inspect registered MCP servers and resolve launch configuration for a server.",
      promptSnippet: "inspect configured MCP servers and their launch details",
      promptGuidelines: [
        "Use mcp_registry before assuming an MCP server id, transport, or launch command.",
      ],
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("resolve-launch"),
          Type.Literal("describe-for-prompt"),
        ]),
        serverId: Type.Optional(
          Type.String({
            description: "Required for get and resolve-launch actions.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (params.action === "describe-for-prompt") {
          return createTextResult(capability.describeForPrompt(), {
            action: params.action,
          });
        }

        if (params.action === "list") {
          const servers = capability.list();
          return createTextResult(
            summarizeNames(
              servers.map((server) => server.id),
              "MCP server",
              "MCP servers",
            ),
            {
              action: params.action,
              servers: servers.map(redactMcpServer),
            },
          );
        }

        const serverId = requireString(params.serverId, "serverId");

        if (params.action === "get") {
          const server = capability.get(serverId);
          if (server === undefined) {
            throw new Error(`Unknown MCP server "${serverId}".`);
          }

          return createTextResult(`Loaded MCP server "${serverId}".`, {
            action: params.action,
            server: redactMcpServer(server),
          });
        }

        const launch = capability.resolveLaunch(serverId);
        return createTextResult(`Resolved launch configuration for MCP server "${serverId}".`, {
          action: params.action,
          launch: redactMcpServer(launch),
        });
      },
    }),
    ["mcp.read", "mcp.launch", "secret.read"],
  );
}

function createMessagingTool(capability: PiCapabilityMessaging): ToolDefinition {
  return withAgentHarnessToolEffects(
    defineTool({
      name: "agent_messages",
      label: "Agent Messages",
      description: "Send, inspect, and search durable inter-agent messages.",
      promptSnippet: "send or inspect durable messages between agents",
      promptGuidelines: [
        "Use agent_messages when work must survive beyond the current in-memory turn.",
      ],
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("send"),
          Type.Literal("inbox"),
          Type.Literal("thread"),
          Type.Literal("mark-read"),
          Type.Literal("search"),
        ]),
        agentId: Type.Optional(
          Type.String({
            description: "Required for inbox and search actions.",
          }),
        ),
        messageId: Type.Optional(
          Type.String({
            description: "Required for mark-read.",
          }),
        ),
        threadId: Type.Optional(
          Type.String({
            description: "Required for thread.",
          }),
        ),
        from: Type.Optional(
          Type.String({
            description: "Required for send.",
          }),
        ),
        to: Type.Optional(
          Type.String({
            description: "Required for send.",
          }),
        ),
        subject: Type.Optional(Type.String()),
        body: Type.Optional(
          Type.String({
            description: "Required for send.",
          }),
        ),
        query: Type.Optional(
          Type.String({
            description: "Required for search.",
          }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        unreadOnly: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params) {
        switch (params.action) {
          case "send": {
            const message = capability.send({
              from: requireString(params.from, "from"),
              to: requireString(params.to, "to"),
              body: requireString(params.body, "body"),
              ...(params.subject === undefined ? {} : { subject: params.subject }),
              ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
            });

            return createTextResult(`Sent durable message "${message.id}" to ${message.to}.`, {
              action: params.action,
              message,
            });
          }

          case "inbox": {
            const messages = capability.inbox(requireString(params.agentId, "agentId"), {
              ...(params.limit === undefined ? {} : { limit: params.limit }),
              ...(params.unreadOnly === undefined ? {} : { unreadOnly: params.unreadOnly }),
            });

            return createTextResult(
              summarizeNames(
                messages.map((message) => message.id),
                "message",
                "messages",
              ),
              {
                action: params.action,
                messages,
              },
            );
          }

          case "thread": {
            const messages = capability.thread(requireString(params.threadId, "threadId"));
            return createTextResult(
              summarizeNames(
                messages.map((message) => message.id),
                "thread message",
                "thread messages",
              ),
              {
                action: params.action,
                messages,
              },
            );
          }

          case "mark-read": {
            const message = capability.markRead(requireString(params.messageId, "messageId"));
            if (message === undefined) {
              throw new Error(`Unknown message "${params.messageId}".`);
            }

            return createTextResult(`Marked message "${message.id}" as read.`, {
              action: params.action,
              message,
            });
          }

          case "search": {
            const results = capability.search(
              requireString(params.agentId, "agentId"),
              requireString(params.query, "query"),
              params.limit,
            );

            return createTextResult(
              summarizeNames(
                results.map((result) => result.message.id),
                "search result",
                "search results",
              ),
              {
                action: params.action,
                results,
              },
            );
          }
        }
      },
    }),
    ["handoff.read", "handoff.write"],
  );
}

function createMemoryTool(capability: PiCapabilityMemory): ToolDefinition {
  return withAgentHarnessToolEffects(
    defineTool({
      name: "agent_memory",
      label: "Agent Memory",
      description: "Write, inspect, search, and delete file-backed agent memories.",
      promptSnippet: "persist or retrieve long-lived agent memory entries",
      promptGuidelines: ["Use agent_memory for durable facts that should survive into later runs."],
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("remember"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("search"),
          Type.Literal("forget"),
        ]),
        agentId: Type.String({
          description: "Agent id whose memory namespace should be used.",
        }),
        entryId: Type.Optional(
          Type.String({
            description: "Required for get and forget. Optional for remember when reusing an id.",
          }),
        ),
        text: Type.Optional(
          Type.String({
            description: "Required for remember.",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String())),
        query: Type.Optional(
          Type.String({
            description: "Required for search.",
          }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        switch (params.action) {
          case "remember": {
            const entry = await capability.remember(params.agentId, {
              text: requireString(params.text, "text"),
              ...(params.entryId === undefined ? {} : { id: params.entryId }),
              ...(params.tags === undefined ? {} : { tags: params.tags }),
            });

            return createTextResult(`Stored memory "${entry.id}" for agent "${params.agentId}".`, {
              action: params.action,
              entry,
            });
          }

          case "get": {
            const entry = await capability.get(
              params.agentId,
              requireString(params.entryId, "entryId"),
            );
            if (entry === undefined) {
              throw new Error(`Unknown memory "${params.entryId}" for agent "${params.agentId}".`);
            }

            return createTextResult(`Loaded memory "${entry.id}" for agent "${params.agentId}".`, {
              action: params.action,
              entry,
            });
          }

          case "list": {
            const entries = await capability.list(params.agentId);
            return createTextResult(
              summarizeNames(
                entries.map((entry) => entry.id),
                "memory entry",
                "memory entries",
              ),
              {
                action: params.action,
                entries,
              },
            );
          }

          case "search": {
            const results = await capability.search(
              params.agentId,
              requireString(params.query, "query"),
              params.limit,
            );

            return createTextResult(
              summarizeNames(
                results.map((result) => result.entry.id),
                "memory search result",
                "memory search results",
              ),
              {
                action: params.action,
                results,
              },
            );
          }

          case "forget": {
            const deleted = await capability.forget(
              params.agentId,
              requireString(params.entryId, "entryId"),
            );

            return createTextResult(
              deleted
                ? `Deleted memory "${params.entryId}" for agent "${params.agentId}".`
                : `No memory "${params.entryId}" exists for agent "${params.agentId}".`,
              {
                action: params.action,
                deleted,
                entryId: params.entryId,
              },
            );
          }
        }
      },
    }),
    ["memory.read", "memory.write"],
  );
}

function getToolName(tool: PiRuntimeTool | ToolDefinition): string {
  const name = tool.name?.trim();
  if (name && name.length > 0) {
    return name;
  }

  throw new Error("Every assembled pi tool must expose a non-empty name.");
}

function assertUniqueToolNames(tools: readonly (PiRuntimeTool | ToolDefinition)[]): void {
  const seen = new Set<string>();

  for (const tool of tools) {
    const name = getToolName(tool);
    if (seen.has(name)) {
      throw new Error(`Duplicate pi tool name "${name}" in runtime assembly.`);
    }

    seen.add(name);
  }
}

function createSkillsOverride(
  snapshot: PiCapabilitySkillsSnapshot | undefined,
  override: PiCapabilityResourceLoaderOptions["skillsOverride"] | undefined,
): PiCapabilityResourceLoaderOptions["skillsOverride"] | undefined {
  if (snapshot === undefined) {
    return override;
  }

  return (base) => {
    const snapshotSkillNames = new Set(snapshot.skills.map((s) => s.name.trim().toLowerCase()));
    const mergedSkills = [
      ...base.skills.filter((s) => !snapshotSkillNames.has(s.name.trim().toLowerCase())),
      ...snapshot.skills,
    ];
    const bridged = {
      skills: mergedSkills,
      diagnostics: [...base.diagnostics, ...snapshot.diagnostics],
    };

    return override ? override(bridged) : bridged;
  };
}

async function createCapabilityResourceLoader(
  options: CreateCapabilityPiAgentSessionOptions,
  skillSnapshot: PiCapabilitySkillsSnapshot | undefined,
): Promise<DefaultResourceLoader> {
  const resourceLoaderOptions = options.resourceLoaderOptions ?? {};
  const skillsOverride = createSkillsOverride(skillSnapshot, resourceLoaderOptions.skillsOverride);
  const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    ...resourceLoaderOptions,
    cwd,
    agentDir,
    ...(options.settingsManager === undefined ? {} : { settingsManager: options.settingsManager }),
    ...(skillsOverride === undefined ? {} : { skillsOverride }),
  });

  await loader.reload();
  return loader;
}

function serializePiSessionEvent(event: AgentSessionEvent): Record<string, unknown> {
  switch (event.type) {
    case "queue_update":
      return {
        type: event.type,
        steering: [...event.steering],
        followUp: [...event.followUp],
      };

    case "compaction_start":
      return {
        type: event.type,
        reason: event.reason,
      };

    case "compaction_end":
      return {
        type: event.type,
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };

    case "auto_retry_start":
      return {
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };

    case "auto_retry_end":
      return {
        type: event.type,
        success: event.success,
        attempt: event.attempt,
        ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
      };

    case "message_start":
    case "message_end":
      return {
        type: event.type,
        role: event.message.role,
      };

    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      return {
        type: event.type,
        assistantMessageEventType: assistantEvent.type,
        ...("delta" in assistantEvent && typeof assistantEvent.delta === "string"
          ? { delta: assistantEvent.delta }
          : {}),
      };
    }

    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };

    case "tool_execution_update":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };

    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };

    case "turn_start":
      return {
        type: event.type,
      };

    case "turn_end":
      return {
        type: event.type,
        toolResultCount: event.toolResults.length,
      };

    case "agent_end":
      return {
        type: event.type,
        messageCount: event.messages.length,
      };

    default:
      return {
        type: event.type,
      };
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function resolveCapabilityPiToolRegistry(
  capabilities: PiCapabilityBindings,
): Promise<PiCapabilityToolRegistry> {
  const tools: PiRuntimeTool[] = [];
  const customTools: ToolDefinition[] = [];

  if (capabilities.terminalTools) {
    tools.push(capabilities.terminalTools.tool);
  }

  if (capabilities.fileTools) {
    tools.push(...capabilities.fileTools.piTools);
  }

  if (capabilities.customTools) {
    customTools.push(...capabilities.customTools);
  }

  if (capabilities.mcp) {
    customTools.push(createMcpRegistryTool(capabilities.mcp));
  }

  if (capabilities.messaging) {
    customTools.push(createMessagingTool(capabilities.messaging));
  }

  if (capabilities.memory) {
    customTools.push(createMemoryTool(capabilities.memory));
  }

  assertUniqueToolNames([...tools, ...customTools]);

  const skillSnapshot = capabilities.skills ? await capabilities.skills.load() : undefined;

  return Object.freeze({
    tools: Object.freeze([...tools]),
    customTools: Object.freeze([...customTools]),
    toolNames: Object.freeze([...tools.map(getToolName), ...customTools.map(getToolName)]),
    ...(skillSnapshot === undefined ? {} : { skillSnapshot }),
  });
}

export async function createCapabilityPiAgentSession(
  options: CreateCapabilityPiAgentSessionOptions,
  factories: PiRuntimeFactories = {},
): Promise<CreateCapabilityPiAgentSessionResult> {
  const toolRegistry = await resolveCapabilityPiToolRegistry(options.capabilities);
  const resourceLoader = await createCapabilityResourceLoader(options, toolRegistry.skillSnapshot);
  const sessionResult = await createPiAgentSession(
    {
      ...options,
      tools: [...toolRegistry.toolNames],
      customTools: [...toolRegistry.tools, ...toolRegistry.customTools] as NonNullable<
        CreateAgentSessionOptions["customTools"]
      >,
      resourceLoader,
    },
    factories,
  );

  return Object.freeze({
    ...sessionResult,
    toolRegistry,
  });
}

export async function runCapabilityPiAgentSession(
  options: RunCapabilityPiAgentSessionOptions,
  factories: PiRuntimeFactories = {},
): Promise<RunCapabilityPiAgentSessionResult> {
  const sessionResult = await createCapabilityPiAgentSession(options, factories);
  const runId = options.runId ?? randomUUID();
  const scopeId = options.rootScopeId ?? "scope/root";
  const eventStream = options.eventStream ?? createCanonicalEventStream({});
  const sessionId = sessionResult.session.sessionId;
  const createdAt = new Date().toISOString();
  const startedAt = new Date().toISOString();
  const eventContext = {
    scopeId,
    runId,
    rootSessionId: sessionId,
    sessionId,
  };

  await eventStream.emit({
    ...eventContext,
    name: "run.created",
    data: {
      toolNames: [...sessionResult.toolRegistry.toolNames],
    },
  });
  await eventStream.emit({
    ...eventContext,
    name: "session.created",
    data: {
      sessionId,
    },
  });
  await eventStream.emit({
    ...eventContext,
    name: "run.started",
  });
  await eventStream.emit({
    ...eventContext,
    name: "session.started",
  });

  let forwarder = Promise.resolve();
  const unsubscribe = sessionResult.session.subscribe((event) => {
    forwarder = forwarder
      .then(() => {
        try {
          return eventStream.emit(
            createPluginEvent(PI_RUNTIME_EVENT_PLUGIN_ID, `pi.${event.type}`, {
              ...eventContext,
              origin: {
                subsystem: "pi-session",
              },
              data: serializePiSessionEvent(event),
            }),
          );
        } catch {
          return undefined;
        }
      })
      .catch(() => undefined)
      .then(() => undefined);
  });

  try {
    await sessionResult.session.prompt(options.prompt, options.promptOptions);
    unsubscribe();
    await forwarder;

    const completedAt = new Date().toISOString();
    await eventStream.emit({
      ...eventContext,
      name: "session.completed",
      data: {
        messageCount: sessionResult.session.messages.length,
      },
    });
    await eventStream.emit({
      ...eventContext,
      name: "run.completed",
      data: {
        messageCount: sessionResult.session.messages.length,
      },
    });

    const events = eventStream.snapshot();
    const lastSequence = events.at(-1)?.sequence;

    return Object.freeze({
      ...sessionResult,
      eventStream,
      events,
      envelope: createRunEnvelope({
        runId,
        rootScopeId: scopeId,
        ...(options.rootAgentId === undefined ? {} : { rootAgentId: options.rootAgentId }),
        mode: options.mode ?? "sync",
        status: "succeeded",
        timestamps: {
          createdAt,
          startedAt,
          completedAt,
        },
        eventStream: {
          kind: "event-stream-reference",
          streamId: runId,
          ...(lastSequence === undefined ? {} : { sequence: lastSequence }),
        },
      }),
    });
  } catch (error) {
    const failureMessage = toErrorMessage(error);
    unsubscribe();
    await forwarder;

    const completedAt = new Date().toISOString();
    await eventStream.emit({
      ...eventContext,
      name: "session.failed",
      data: {
        error: failureMessage,
      },
    });
    await eventStream.emit({
      ...eventContext,
      name: "run.failed",
      data: {
        error: failureMessage,
      },
    });

    const events = eventStream.snapshot();
    const lastSequence = events.at(-1)?.sequence;

    return Object.freeze({
      ...sessionResult,
      eventStream,
      events,
      failureMessage,
      envelope: createRunEnvelope({
        runId,
        rootScopeId: scopeId,
        ...(options.rootAgentId === undefined ? {} : { rootAgentId: options.rootAgentId }),
        mode: options.mode ?? "sync",
        status: "failed",
        timestamps: {
          createdAt,
          startedAt,
          completedAt,
        },
        eventStream: {
          kind: "event-stream-reference",
          streamId: runId,
          ...(lastSequence === undefined ? {} : { sequence: lastSequence }),
        },
      }),
    });
  } finally {
    unsubscribe();
  }
}
