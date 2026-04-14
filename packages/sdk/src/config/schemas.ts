import type { JsonSchema, JsonSchemaEmitter } from "./json-schema.js";
import type { ZodNamespaceLike, ZodTypeLike } from "./zod-like.js";
import {
  AGENT_ID_PATTERN,
  CONFIG_SCHEMA_VERSION,
  PACKAGE_NAME_PATTERN,
  type AgentConfig,
  type FrameworkConfig,
  type PluginConfig,
  type PresetConfig,
  type ResolvedConfig,
} from "./types.js";

export const CONFIG_YAML_CONCERNS = ["framework", "agent", "plugin"] as const;
export const CONFIG_NON_YAML_CONCERNS = ["preset"] as const;

export const CONFIG_CONTRACT_IDS = {
  framework: "https://generic-ai.dev/contracts/config/framework.schema.json",
  agent: "https://generic-ai.dev/contracts/config/agent.schema.json",
  plugin: "https://generic-ai.dev/contracts/config/plugin.schema.json",
  preset: "https://generic-ai.dev/contracts/config/preset.schema.json",
  resolved: "https://generic-ai.dev/contracts/config/resolved.schema.json",
  boundaries: "https://generic-ai.dev/contracts/config/boundaries.json",
} as const;

export interface PluginConfigSchemaFragment<TConfig = unknown> {
  plugin: string;
  configSchema: ZodTypeLike<TConfig>;
  description?: string;
}

export interface CanonicalConfigSchemaBundle {
  framework: ZodTypeLike<FrameworkConfig>;
  agent: ZodTypeLike<AgentConfig>;
  plugin: ZodTypeLike<PluginConfig>;
  preset: ZodTypeLike<PresetConfig>;
  resolved: ZodTypeLike<ResolvedConfig>;
  composePluginSchema: (
    fragments?: readonly PluginConfigSchemaFragment[],
  ) => ZodTypeLike<PluginConfig>;
  composeResolvedSchema: (
    fragments?: readonly PluginConfigSchemaFragment[],
  ) => ZodTypeLike<ResolvedConfig>;
}

export interface CanonicalConfigJsonSchemas {
  framework: JsonSchema;
  agent: JsonSchema;
  plugin: JsonSchema;
  preset: JsonSchema;
  resolved: JsonSchema;
}

export const definePluginConfigSchemaFragment = <TConfig>(
  fragment: PluginConfigSchemaFragment<TConfig>,
): PluginConfigSchemaFragment<TConfig> => fragment;

const ensureUniqueStrings = <TOutput extends string[]>(
  schema: ZodTypeLike<TOutput>,
  fieldName: string,
): ZodTypeLike<TOutput> =>
  schema.refine(
    (values) => new Set(values).size === values.length,
    `${fieldName} entries must be unique`,
  );

export const createCanonicalConfigSchemas = (z: ZodNamespaceLike): CanonicalConfigSchemaBundle => {
  const packageName = z
    .string()
    .min(1, "package-style identifier cannot be empty")
    .regex(new RegExp(PACKAGE_NAME_PATTERN), "must be a valid package-style identifier");

  const agentId = z
    .string()
    .min(1, "agent id cannot be empty")
    .regex(new RegExp(AGENT_ID_PATTERN), "must be a valid agent identifier");

  const framework = z
    .object({
      schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).optional(),
      name: z.string().min(1, "name cannot be empty").optional(),
      id: agentId.optional(),
      preset: packageName.optional(),
      primaryAgent: agentId.optional(),
      plugins: ensureUniqueStrings(z.array(packageName), "framework.plugins").optional(),
      runtime: z
        .object({
          mode: z.string().min(1, "runtime.mode cannot be empty").optional(),
          retries: z.number().int("runtime.retries must be an integer").nonnegative().optional(),
          tracing: z.boolean().optional(),
          workspaceRoot: z.string().min(1, "workspaceRoot cannot be empty").optional(),
          storage: z
            .object({
              provider: packageName.optional(),
            })
            .optional(),
          queue: z
            .object({
              provider: packageName.optional(),
            })
            .optional(),
          logging: z
            .object({
              level: z
                .string()
                .regex(/^(debug|info|warn|error)$/, "logging level must be debug/info/warn/error")
                .optional(),
            })
            .optional(),
        })
        .optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .describe(
      "Canonical YAML concern schema for .generic-ai/framework.yaml",
    ) as ZodTypeLike<FrameworkConfig>;

  const agent = z
    .object({
      id: agentId,
      displayName: z.string().min(1, "displayName cannot be empty").optional(),
      model: z.string().min(1, "model cannot be empty").optional(),
      instructions: z.string().min(1, "instructions cannot be empty").optional(),
      preset: packageName.optional(),
      plugins: ensureUniqueStrings(z.array(packageName), "agent.plugins").optional(),
      tools: ensureUniqueStrings(
        z.array(z.string().min(1, "tool id cannot be empty")),
        "agent.tools",
      ).optional(),
      memory: z
        .object({
          provider: packageName.optional(),
          path: z.string().min(1, "memory.path cannot be empty").optional(),
          maxEntries: z
            .number()
            .int("memory.maxEntries must be an integer")
            .nonnegative()
            .optional(),
        })
        .optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .describe(
      "Canonical YAML concern schema for .generic-ai/agents/*.yaml",
    ) as ZodTypeLike<AgentConfig>;

  const plugin = z
    .object({
      plugin: packageName.optional(),
      package: packageName.optional(),
      enabled: z.boolean().default(true).optional(),
      dependsOn: ensureUniqueStrings(z.array(packageName), "plugin.dependsOn").optional(),
      config: z.record(z.unknown()).optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .describe(
      "Canonical YAML concern schema for .generic-ai/plugins/*.yaml",
    ) as ZodTypeLike<PluginConfig>;

  const preset = z
    .object({
      id: packageName,
      name: z.string().min(1, "name cannot be empty").optional(),
      description: z.string().min(1, "description cannot be empty").optional(),
      isDefault: z.boolean().optional(),
      plugins: z
        .array(
          z.object({
            id: packageName,
            packageName: packageName.optional(),
            required: z.boolean().optional(),
            description: z.string().min(1, "plugin description cannot be empty").optional(),
          }),
        )
        .optional(),
      frameworkDefaults: (
        framework as ZodTypeLike<FrameworkConfig> & {
          partial(): ZodTypeLike<Partial<FrameworkConfig>>;
        }
      )
        .partial()
        .optional(),
      agentDefaults: z
        .record(
          (
            agent as ZodTypeLike<AgentConfig> & { partial(): ZodTypeLike<Partial<AgentConfig>> }
          ).partial(),
        )
        .optional(),
      pluginDefaults: z
        .record(
          (
            plugin as ZodTypeLike<PluginConfig> & { partial(): ZodTypeLike<Partial<PluginConfig>> }
          ).partial(),
        )
        .optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .describe(
      "Preset package/default composition metadata contract (not a user-facing YAML concern)",
    ) as ZodTypeLike<PresetConfig>;

  const composePluginSchema = (
    fragments: readonly PluginConfigSchemaFragment[] = [],
  ): ZodTypeLike<PluginConfig> => {
    if (fragments.length === 0) {
      return plugin;
    }

    const fragmentByPlugin = new Map<string, PluginConfigSchemaFragment>();
    for (const fragment of fragments) {
      fragmentByPlugin.set(fragment.plugin, fragment);
    }

    return plugin.refine((candidate) => {
      if (!candidate.plugin) {
        return true;
      }

      const fragment = fragmentByPlugin.get(candidate.plugin);
      if (!fragment || candidate.config === undefined) {
        return true;
      }

      return fragment.configSchema.safeParse(candidate.config).success;
    }, "plugin.config does not match its registered plugin schema fragment") as ZodTypeLike<PluginConfig>;
  };

  const composeResolvedSchema = (
    fragments: readonly PluginConfigSchemaFragment[] = [],
  ): ZodTypeLike<ResolvedConfig> =>
    z
      .object({
        framework,
        agents: z.record(agent).default({}),
        plugins: z.record(composePluginSchema(fragments)).default({}),
        preset: preset.optional(),
        sources: z
          .object({
            framework: z.string().optional(),
            agents: z.record(z.string()).optional(),
            plugins: z.record(z.string()).optional(),
            order: z.array(z.string()).optional(),
          })
          .optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .describe(
        "Resolved config layer composed from framework/agent/plugin YAML concerns plus preset metadata",
      ) as ZodTypeLike<ResolvedConfig>;

  return {
    framework,
    agent,
    plugin,
    preset,
    resolved: composeResolvedSchema(),
    composePluginSchema,
    composeResolvedSchema,
  };
};

export const emitCanonicalConfigJsonSchemas = (
  emitter: JsonSchemaEmitter<ZodTypeLike<unknown>>,
  schemas: CanonicalConfigSchemaBundle,
): CanonicalConfigJsonSchemas => ({
  framework: emitter.emit(schemas.framework, CONFIG_CONTRACT_IDS.framework),
  agent: emitter.emit(schemas.agent, CONFIG_CONTRACT_IDS.agent),
  plugin: emitter.emit(schemas.plugin, CONFIG_CONTRACT_IDS.plugin),
  preset: emitter.emit(schemas.preset, CONFIG_CONTRACT_IDS.preset),
  resolved: emitter.emit(schemas.resolved, CONFIG_CONTRACT_IDS.resolved),
});
