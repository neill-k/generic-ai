import type { JsonSchema, JsonSchemaEmitter } from "./json-schema.js";
import type { ZodNamespaceLike, ZodTypeLike } from "./zod-like.js";
import {
  AGENT_HARNESS_CAPABILITY_EFFECTS,
  AGENT_HARNESS_LOOP_STAGE_KINDS,
} from "../harness/types.js";
import {
  AGENT_ID_PATTERN,
  CONFIG_SCHEMA_VERSION,
  PACKAGE_NAME_PATTERN,
  type AgentConfig,
  type AgentHarnessConfig,
  type FrameworkConfig,
  type PluginConfig,
  type PresetConfig,
  type ResolvedConfig,
} from "./types.js";

export const CONFIG_YAML_CONCERNS = ["framework", "agent", "harness", "plugin"] as const;
export const CONFIG_NON_YAML_CONCERNS = ["preset"] as const;

export const CONFIG_CONTRACT_IDS = {
  framework: "https://generic-ai.dev/contracts/config/framework.schema.json",
  agent: "https://generic-ai.dev/contracts/config/agent.schema.json",
  harness: "https://generic-ai.dev/contracts/config/harness.schema.json",
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
  harness: ZodTypeLike<AgentHarnessConfig>;
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
  harness: JsonSchema;
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

const ensureUniqueIds = <TOutput extends { id: string }[]>(
  schema: ZodTypeLike<TOutput>,
  fieldName: string,
): ZodTypeLike<TOutput> =>
  schema.refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
    `${fieldName} ids must be unique`,
  );

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const oneOfRegex = (values: readonly string[], extraPattern?: string): RegExp =>
  new RegExp(
    `^(?:${[...values.map(escapeRegex), ...(extraPattern ? [extraPattern] : [])].join("|")})$`,
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
  const loopStageKind = z
    .string()
    .regex(
      oneOfRegex(AGENT_HARNESS_LOOP_STAGE_KINDS),
      "loop stage kind must be state/context-builder/controller/tool-router/policy-gate/executor/verifier/custom",
    );
  const capabilityEffect = z
    .string()
    .regex(
      oneOfRegex(AGENT_HARNESS_CAPABILITY_EFFECTS, "custom\\.[A-Za-z0-9._-]+"),
      "loop stage effects must be known harness capability effects or custom.*",
    );

  const framework = z
    .object({
      schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).optional(),
      name: z.string().min(1, "name cannot be empty").optional(),
      id: agentId.optional(),
      preset: packageName.optional(),
      primaryAgent: agentId.optional(),
      primaryHarness: agentId.optional(),
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

  const harnessLoop = z
    .object({
      id: agentId.optional(),
      pattern: z
        .string()
        .regex(
          /^(thread-turn-tool-policy|custom\.[A-Za-z0-9._-]+)$/,
          "loop.pattern must be thread-turn-tool-policy or custom.*",
        )
        .optional(),
      stateModel: z
        .string()
        .regex(
          /^(thread-turn-item|custom\.[A-Za-z0-9._-]+)$/,
          "loop.stateModel must be thread-turn-item or custom.*",
        )
        .optional(),
      entryStage: agentId.optional(),
      terminalStages: ensureUniqueStrings(z.array(agentId), "loop.terminalStages").optional(),
      stages: ensureUniqueIds(
        z
          .array(
            z.object({
              id: agentId,
              kind: loopStageKind,
              roleRef: agentId.optional(),
              description: z.string().min(1, "loop stage description cannot be empty").optional(),
              tools: ensureUniqueStrings(
                z.array(z.string().min(1, "loop stage tool id cannot be empty")),
                "loop stage tools",
              ).optional(),
              effects: ensureUniqueStrings(
                z.array(capabilityEffect),
                "loop stage effects",
              ).optional(),
              readOnly: z.boolean().optional(),
              metadata: z.record(z.unknown()).optional(),
            }),
          )
          .min(1, "loop.stages must include at least one stage"),
        "loop.stages",
      ),
      transitions: z
        .array(
          z.object({
            from: agentId,
            to: agentId,
            label: z.string().min(1, "loop transition label cannot be empty").optional(),
            metadata: z.record(z.unknown()).optional(),
          }),
        )
        .optional(),
      invariants: ensureUniqueStrings(
        z.array(z.string().min(1, "loop invariant cannot be empty")),
        "loop.invariants",
      ).optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .refine((loop) => {
      const stageIds = new Set(loop.stages.map((stage) => stage.id));
      if (loop.entryStage !== undefined && !stageIds.has(loop.entryStage)) {
        return false;
      }
      if (loop.terminalStages?.some((stageId) => !stageIds.has(stageId))) {
        return false;
      }
      return (loop.transitions ?? []).every(
        (transition) => stageIds.has(transition.from) && stageIds.has(transition.to),
      );
    }, "loop references must point to declared stages");

  const harness = z
    .object({
      id: agentId,
      displayName: z.string().min(1, "displayName cannot be empty").optional(),
      adapter: z
        .string()
        .regex(/^(pi|external)$/, "adapter must be pi or external")
        .optional(),
      controller: z
        .string()
        .regex(/^model-directed$/, "controller must be model-directed")
        .optional(),
      model: z.string().min(1, "model cannot be empty").optional(),
      primaryAgent: agentId.optional(),
      policyProfile: z
        .string()
        .regex(
          /^(local-dev-full|benchmark-container)$/,
          "policyProfile must be local-dev-full or benchmark-container",
        )
        .optional(),
      roles: z
        .array(
          z.object({
            id: agentId,
            kind: z
              .string()
              .regex(
                /^(root|planner|explorer|builder|verifier|custom)$/,
                "role.kind must be root/planner/explorer/builder/verifier/custom",
              ),
            description: z.string().min(1, "role.description cannot be empty").optional(),
            instructions: z.string().min(1, "role.instructions cannot be empty").optional(),
            model: z.string().min(1, "role.model cannot be empty").optional(),
            tools: ensureUniqueStrings(
              z.array(z.string().min(1, "role tool id cannot be empty")),
              "role.tools",
            ).optional(),
            readOnly: z.boolean().optional(),
            metadata: z.record(z.unknown()).optional(),
          }),
        )
        .optional(),
      loop: harnessLoop.optional(),
      tools: ensureUniqueStrings(
        z.array(z.string().min(1, "harness tool id cannot be empty")),
        "harness.tools",
      ).optional(),
      allowNetwork: z.boolean().optional(),
      allowMcp: z.boolean().optional(),
      artifactDir: z.string().min(1, "artifactDir cannot be empty").optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .describe(
      "Canonical YAML concern schema for .generic-ai/harnesses/*.yaml",
    ) as ZodTypeLike<AgentHarnessConfig>;

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
        harnesses: z.record(harness).default({}),
        plugins: z.record(composePluginSchema(fragments)).default({}),
        preset: preset.optional(),
        sources: z
          .object({
            framework: z.string().optional(),
            agents: z.record(z.string()).optional(),
            harnesses: z.record(z.string()).optional(),
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
    harness,
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
  harness: emitter.emit(schemas.harness, CONFIG_CONTRACT_IDS.harness),
  plugin: emitter.emit(schemas.plugin, CONFIG_CONTRACT_IDS.plugin),
  preset: emitter.emit(schemas.preset, CONFIG_CONTRACT_IDS.preset),
  resolved: emitter.emit(schemas.resolved, CONFIG_CONTRACT_IDS.resolved),
});
