import {
  AGENT_HARNESS_CAPABILITY_EFFECTS,
  type AgentHarnessCapabilityEffect,
  type ConfigSchemaContract,
  helpers,
} from "@generic-ai/sdk";

import type { McpReconnectOptions, McpRetryOnDisconnect } from "./client.js";
import {
  McpRegistryError,
  type McpServerDefinition,
  name,
  normalizeMcpServer,
} from "./registry.js";

/** Plugin config, as written under `config:` in `.generic-ai/plugins/plugin-mcp.yaml`. */
export interface McpPluginConfig {
  readonly servers: readonly McpServerDefinition[];
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly reconnect?: McpReconnectOptions;
  readonly retryOnDisconnect?: McpRetryOnDisconnect;
  /** Maximum characters of tool text returned to the model per call. */
  readonly maxOutputChars?: number;
}

const STRING_RECORD_SCHEMA = { type: "object", additionalProperties: { type: "string" } };
const STRING_ARRAY_SCHEMA = { type: "array", items: { type: "string", minLength: 1 } };
const EFFECT_ARRAY_SCHEMA = { type: "array", items: { type: "string", minLength: 1 } };
const POSITIVE_INTEGER_SCHEMA = { type: "integer", minimum: 1 };

const SERVER_SCHEMA = {
  type: "object",
  required: ["id", "transport"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    transport: { type: "string", enum: ["stdio", "http", "sse"] },
    description: { type: "string" },
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    env: STRING_RECORD_SCHEMA,
    cwd: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    headers: STRING_RECORD_SCHEMA,
    roots: STRING_ARRAY_SCHEMA,
    enabled: { type: "boolean" },
    required: { type: "boolean" },
    timeoutMs: POSITIVE_INTEGER_SCHEMA,
    toolPrefix: { type: "string", minLength: 1 },
    tools: {
      type: "object",
      properties: { include: STRING_ARRAY_SCHEMA, exclude: STRING_ARRAY_SCHEMA },
      additionalProperties: false,
    },
    readOnly: { type: "boolean" },
    trustAnnotations: { type: "boolean" },
    readOnlyTools: STRING_ARRAY_SCHEMA,
    effects: EFFECT_ARRAY_SCHEMA,
    toolEffects: { type: "object", additionalProperties: EFFECT_ARRAY_SCHEMA },
  },
  additionalProperties: false,
};

function fail(message: string): never {
  throw new McpRegistryError("INVALID_SERVER", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer.`);
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    fail(`${label} must map names to strings.`);
  }
  return value as Record<string, string>;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be a list of strings.`);
  }
  return value as string[];
}

function isEffect(value: string): value is AgentHarnessCapabilityEffect {
  return (
    (AGENT_HARNESS_CAPABILITY_EFFECTS as readonly string[]).includes(value) ||
    /^custom\.[A-Za-z0-9._-]+$/.test(value)
  );
}

function effectArray(value: unknown, label: string): AgentHarnessCapabilityEffect[] | undefined {
  const entries = stringArray(value, label);
  if (entries === undefined) {
    return undefined;
  }
  for (const entry of entries) {
    if (!isEffect(entry)) {
      fail(`${label} contains unknown effect "${entry}".`);
    }
  }
  return entries as AgentHarnessCapabilityEffect[];
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail(`${label} must be true or false.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  return value;
}

const SERVER_KEYS = new Set(Object.keys(SERVER_SCHEMA.properties));

export function parseMcpServerDefinition(input: unknown, index = 0): McpServerDefinition {
  const label = `servers[${index}]`;
  if (!isRecord(input)) {
    fail(`${label} must be an object.`);
  }
  for (const key of Object.keys(input)) {
    if (!SERVER_KEYS.has(key)) {
      fail(`${label} has unknown field "${key}".`);
    }
  }
  const tools = input["tools"];
  if (tools !== undefined && !isRecord(tools)) {
    fail(`${label}.tools must be an object with include and/or exclude lists.`);
  }
  const toolEffectsInput = input["toolEffects"];
  if (toolEffectsInput !== undefined && !isRecord(toolEffectsInput)) {
    fail(`${label}.toolEffects must map tool names to effect lists.`);
  }

  const id = optionalString(input["id"], `${label}.id`) ?? fail(`${label}.id is required.`);
  const transport = optionalString(input["transport"], `${label}.transport`);
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    fail(`${label}.transport must be stdio, http or sse.`);
  }
  const include =
    tools === undefined ? undefined : stringArray(tools["include"], `${label}.tools.include`);
  const exclude =
    tools === undefined ? undefined : stringArray(tools["exclude"], `${label}.tools.exclude`);
  const toolEffects =
    toolEffectsInput === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(toolEffectsInput).map(([tool, effects]) => [
            tool,
            effectArray(effects, `${label}.toolEffects.${tool}`) ?? [],
          ]),
        );

  const fields = {
    description: optionalString(input["description"], `${label}.description`),
    command: optionalString(input["command"], `${label}.command`),
    args: stringArray(input["args"], `${label}.args`),
    env: stringRecord(input["env"], `${label}.env`),
    cwd: optionalString(input["cwd"], `${label}.cwd`),
    url: optionalString(input["url"], `${label}.url`),
    headers: stringRecord(input["headers"], `${label}.headers`),
    roots: stringArray(input["roots"], `${label}.roots`),
    enabled: optionalBoolean(input["enabled"], `${label}.enabled`),
    required: optionalBoolean(input["required"], `${label}.required`),
    timeoutMs: optionalPositiveInteger(input["timeoutMs"], `${label}.timeoutMs`),
    toolPrefix: optionalString(input["toolPrefix"], `${label}.toolPrefix`),
    tools:
      tools === undefined
        ? undefined
        : {
            ...(include === undefined ? {} : { include }),
            ...(exclude === undefined ? {} : { exclude }),
          },
    readOnly: optionalBoolean(input["readOnly"], `${label}.readOnly`),
    trustAnnotations: optionalBoolean(input["trustAnnotations"], `${label}.trustAnnotations`),
    readOnlyTools: stringArray(input["readOnlyTools"], `${label}.readOnlyTools`),
    effects: effectArray(input["effects"], `${label}.effects`),
    toolEffects,
  };

  const server = Object.fromEntries(
    Object.entries({ id, transport, ...fields }).filter(([, value]) => value !== undefined),
  ) as unknown as McpServerDefinition;
  return normalizeMcpServer(server);
}

export function parseMcpPluginConfig(input: unknown): McpPluginConfig {
  const value = input === undefined || input === null ? {} : input;
  if (!isRecord(value)) {
    fail("MCP plugin config must be an object.");
  }
  const serversInput = value["servers"] ?? [];
  if (!Array.isArray(serversInput)) {
    fail("servers must be a list.");
  }
  const servers = serversInput.map((server, index) => parseMcpServerDefinition(server, index));
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) {
      throw new McpRegistryError(
        "DUPLICATE_SERVER",
        `MCP server "${server.id}" is configured twice.`,
      );
    }
    ids.add(server.id);
  }

  const reconnectInput = value["reconnect"];
  if (reconnectInput !== undefined && !isRecord(reconnectInput)) {
    fail("reconnect must be an object.");
  }
  const reconnect =
    reconnectInput === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries({
            maxAttempts: optionalNonNegativeInteger(
              reconnectInput["maxAttempts"],
              "reconnect.maxAttempts",
            ),
            initialDelayMs: optionalNonNegativeInteger(
              reconnectInput["initialDelayMs"],
              "reconnect.initialDelayMs",
            ),
            maxDelayMs: optionalNonNegativeInteger(
              reconnectInput["maxDelayMs"],
              "reconnect.maxDelayMs",
            ),
          }).filter(([, entry]) => entry !== undefined),
        );
  const retryOnDisconnect = value["retryOnDisconnect"];
  if (
    retryOnDisconnect !== undefined &&
    retryOnDisconnect !== "never" &&
    retryOnDisconnect !== "read-only" &&
    retryOnDisconnect !== "always"
  ) {
    fail("retryOnDisconnect must be never, read-only or always.");
  }
  const timeoutMs = optionalPositiveInteger(value["timeoutMs"], "timeoutMs");
  const connectTimeoutMs = optionalPositiveInteger(value["connectTimeoutMs"], "connectTimeoutMs");
  const maxOutputChars = optionalPositiveInteger(value["maxOutputChars"], "maxOutputChars");

  return Object.freeze({
    servers: Object.freeze(servers),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(reconnect === undefined ? {} : { reconnect }),
    ...(retryOnDisconnect === undefined
      ? {}
      : { retryOnDisconnect: retryOnDisconnect as McpRetryOnDisconnect }),
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
  });
}

export const mcpPluginConfigSchema: ConfigSchemaContract<McpPluginConfig> =
  helpers.defineConfigSchema<McpPluginConfig>({
    kind: "config-schema",
    id: `${name}.config`,
    description: "MCP servers to connect to and how their tools reach agents.",
    schema: {
      type: "object",
      properties: {
        servers: { type: "array", items: SERVER_SCHEMA },
        timeoutMs: POSITIVE_INTEGER_SCHEMA,
        connectTimeoutMs: POSITIVE_INTEGER_SCHEMA,
        reconnect: {
          type: "object",
          properties: {
            maxAttempts: { type: "integer", minimum: 0 },
            initialDelayMs: { type: "integer", minimum: 0 },
            maxDelayMs: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        retryOnDisconnect: { type: "string", enum: ["never", "read-only", "always"] },
        maxOutputChars: POSITIVE_INTEGER_SCHEMA,
      },
      additionalProperties: false,
    },
    defaults: { servers: [] },
    parse: parseMcpPluginConfig,
    merge(base, next) {
      return parseMcpPluginConfig({ ...base, ...next });
    },
  });
