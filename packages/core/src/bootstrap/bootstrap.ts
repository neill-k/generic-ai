import { isAbsolute, resolve } from "node:path";

import type { AgentConfig, PluginConfig } from "@generic-ai/sdk";
import {
  resolveStarterCapabilities,
  resolveStarterPorts,
  starterPreset,
} from "./starter-preset.js";
import type {
  BootstrapCapabilityId,
  BootstrapPortDescriptor,
  BootstrapPortOverrides,
  BootstrapPorts,
  BootstrapPresetDefinition,
  BootstrapPresetInput,
  GenericAIAgentSessionPlan,
  GenericAIBootstrap,
  GenericAIConfigLoaderOptions,
  GenericAIConfigLoadFailure,
  GenericAIConfiguredBootstrap,
  GenericAIConfigValidationDiagnostic,
  GenericAIFromConfigOptions,
  GenericAIOptions,
  GenericAIPluginInitPlan,
  GenericAIResolvedConfig,
  GenericAIRuntimePlan,
  GenericAIRuntimeSettingsPlan,
  GenericAIRuntimeStarterInput,
  GenericAIRuntimeStartResult,
} from "./types.js";

function mergePortDescriptor(
  base: BootstrapPortDescriptor,
  override: Partial<BootstrapPortDescriptor> | undefined,
): BootstrapPortDescriptor {
  if (override === undefined) {
    return base;
  }

  return Object.freeze({
    ...base,
    ...override,
  });
}

function resolvePorts(
  base: BootstrapPorts,
  override: BootstrapPortOverrides | undefined,
): BootstrapPorts {
  if (override === undefined) {
    return base;
  }

  return Object.freeze({
    pluginHost: mergePortDescriptor(base.pluginHost, override.pluginHost),
    runMode: mergePortDescriptor(base.runMode, override.runMode),
    runEnvelope: mergePortDescriptor(base.runEnvelope, override.runEnvelope),
    piBoundary: mergePortDescriptor(base.piBoundary, override.piBoundary),
  });
}

function resolvePreset(
  input: BootstrapPresetInput | undefined,
  capabilities: ReadonlyArray<BootstrapCapabilityId>,
  ports: BootstrapPorts,
): BootstrapPresetDefinition {
  const base = input ?? {};

  return Object.freeze({
    ...starterPreset,
    ...base,
    capabilities: Object.freeze([...capabilities]),
    ports,
  });
}

export class GenericAIConfigError extends Error {
  readonly diagnostics: readonly GenericAIConfigValidationDiagnostic[];
  readonly failures: readonly GenericAIConfigLoadFailure[];

  constructor(input: {
    readonly message: string;
    readonly diagnostics?: readonly GenericAIConfigValidationDiagnostic[];
    readonly failures?: readonly GenericAIConfigLoadFailure[];
  }) {
    super(input.message);
    this.name = "GenericAIConfigError";
    this.diagnostics = Object.freeze([...(input.diagnostics ?? [])]);
    this.failures = Object.freeze([...(input.failures ?? [])]);
  }
}

export function createGenericAI(options: GenericAIOptions = {}): GenericAIBootstrap {
  const capabilities = resolveStarterCapabilities(
    options.capabilities ?? options.preset?.capabilities,
  );
  const ports = resolvePorts(resolveStarterPorts(options.preset?.ports), options.ports);
  const preset = resolvePreset(options.preset, capabilities, ports);

  return Object.freeze({
    preset,
    capabilities,
    ports,
    describe: () =>
      `${preset.name} [${preset.id}] with ${preset.capabilities.length} capabilities via ${preset.transport}`,
  });
}

export async function createGenericAIFromConfig<
  TSchemaSource = unknown,
  TRuntimeStart = GenericAIRuntimeStartResult,
>(
  options: GenericAIFromConfigOptions<TSchemaSource, TRuntimeStart>,
): Promise<GenericAIConfiguredBootstrap<TRuntimeStart>> {
  const config = await resolveConfig(options);
  const composition = createGenericAI(resolveBootstrapOptions(config, options));
  const runtimePlan = createRuntimePlan(config, options);

  const starterInput: GenericAIRuntimeStarterInput = Object.freeze({
    preset: composition.preset,
    capabilities: composition.capabilities,
    ports: composition.ports,
    config,
    runtimePlan,
  });

  return Object.freeze({
    ...composition,
    config,
    runtimePlan,
    startRuntime: async () => {
      if (options.startRuntime === undefined) {
        return Object.freeze({
          status: "planned",
          plan: runtimePlan,
        }) as TRuntimeStart;
      }

      return options.startRuntime(starterInput);
    },
  });
}

async function resolveConfig<TSchemaSource, TRuntimeStart>(
  options: GenericAIFromConfigOptions<TSchemaSource, TRuntimeStart>,
): Promise<GenericAIResolvedConfig> {
  if (options.config !== undefined && options.configSource !== undefined) {
    throw new GenericAIConfigError({
      message: "Provide either a resolved config or a configSource, not both.",
      failures: [
        {
          code: "CONFIG_SOURCE_CONFLICT",
          message: "Both config and configSource were provided.",
          suggestion: "Use config for tests/preloaded config, or configSource for YAML discovery.",
        },
      ],
    });
  }

  if (options.config !== undefined) {
    return freezeResolvedConfig(options.config);
  }

  const source = options.configSource;
  if (source === undefined) {
    throw new GenericAIConfigError({
      message: "Config-aware bootstrap requires config or configSource.",
      failures: [
        {
          code: "CONFIG_SOURCE_MISSING",
          message: "No resolved config or config loader was provided.",
          suggestion: "Pass config for a preloaded object or configSource to load canonical YAML.",
        },
      ],
    });
  }

  const loadOptions = createLoaderOptions(source);
  const result = await source.load(source.startDir, loadOptions);
  if (!result.ok) {
    const errorInput: {
      message: string;
      diagnostics?: readonly GenericAIConfigValidationDiagnostic[];
      failures?: readonly GenericAIConfigLoadFailure[];
    } = {
      message: summarizeConfigLoadFailure(result.failures, result.diagnostics),
    };

    if (result.diagnostics !== undefined) {
      errorInput.diagnostics = result.diagnostics;
    }
    if (result.failures !== undefined) {
      errorInput.failures = result.failures;
    }

    throw new GenericAIConfigError(errorInput);
  }

  return freezeResolvedConfig(result.config);
}

function createLoaderOptions<TSchemaSource>(
  source: NonNullable<GenericAIFromConfigOptions<TSchemaSource>["configSource"]>,
): GenericAIConfigLoaderOptions<TSchemaSource> {
  const options: {
    schemaSource?: TSchemaSource;
    rejectUnknownPluginNamespaces?: boolean;
    requireFramework?: boolean;
  } = {};

  if (source.schemaSource !== undefined) {
    options.schemaSource = source.schemaSource;
  }
  if (source.rejectUnknownPluginNamespaces !== undefined) {
    options.rejectUnknownPluginNamespaces = source.rejectUnknownPluginNamespaces;
  }
  if (source.requireFramework !== undefined) {
    options.requireFramework = source.requireFramework;
  }

  return options;
}

function summarizeConfigLoadFailure(
  failures: readonly GenericAIConfigLoadFailure[] | undefined,
  diagnostics: readonly GenericAIConfigValidationDiagnostic[] | undefined,
): string {
  const firstFailure = failures?.[0];
  if (firstFailure) {
    return firstFailure.message;
  }

  const firstDiagnostic = diagnostics?.[0];
  if (firstDiagnostic) {
    return firstDiagnostic.message;
  }

  return "Generic AI config load failed.";
}

function resolveBootstrapOptions<TSchemaSource, TRuntimeStart>(
  config: GenericAIResolvedConfig,
  options: GenericAIFromConfigOptions<TSchemaSource, TRuntimeStart>,
): GenericAIOptions {
  const preset = options.preset ?? createPresetInputFromConfig(config);
  const resolved: {
    preset?: BootstrapPresetInput;
    capabilities?: ReadonlyArray<BootstrapCapabilityId>;
    ports?: BootstrapPortOverrides;
  } = {};

  if (preset !== undefined) {
    resolved.preset = preset;
  }
  if (options.capabilities !== undefined) {
    resolved.capabilities = options.capabilities;
  }
  if (options.ports !== undefined) {
    resolved.ports = options.ports;
  }

  return resolved;
}

function createPresetInputFromConfig(
  config: GenericAIResolvedConfig,
): BootstrapPresetInput | undefined {
  const framework = config.framework;
  if (framework.preset === undefined && framework.name === undefined) {
    return undefined;
  }

  const preset: {
    id?: string;
    name?: string;
  } = {};

  if (framework.preset !== undefined) {
    preset.id = framework.preset;
  }
  if (framework.name !== undefined) {
    preset.name = framework.name;
  }

  return preset;
}

function createRuntimePlan<TSchemaSource, TRuntimeStart>(
  config: GenericAIResolvedConfig,
  options: GenericAIFromConfigOptions<TSchemaSource, TRuntimeStart>,
): GenericAIRuntimePlan {
  const runtime = createRuntimeSettingsPlan(config, options.configSource?.startDir);
  const primaryAgent = createPrimaryAgentPlan(config, options.primaryAgentId);
  const plugins = createPluginInitPlans(config);

  return Object.freeze({
    runtime,
    primaryAgent,
    plugins,
    ...(config.sources === undefined ? {} : { sources: cloneSources(config.sources) }),
  });
}

function createRuntimeSettingsPlan(
  config: GenericAIResolvedConfig,
  startDir: string | undefined,
): GenericAIRuntimeSettingsPlan {
  const runtime = config.framework.runtime ?? {};
  const baseRoot = config.rootDir ?? startDir ?? ".";
  const workspaceRoot = normalizeWorkspaceRoot(runtime.workspaceRoot, baseRoot);
  const plan: {
    mode?: string;
    retries?: number;
    tracing?: boolean;
    workspaceRoot: string;
    storageProvider?: string;
    queueProvider?: string;
    loggingLevel?: "debug" | "info" | "warn" | "error";
  } = {
    workspaceRoot,
  };

  if (runtime.mode !== undefined) {
    plan.mode = runtime.mode;
  }
  if (runtime.retries !== undefined) {
    plan.retries = runtime.retries;
  }
  if (runtime.tracing !== undefined) {
    plan.tracing = runtime.tracing;
  }
  if (runtime.storage?.provider !== undefined) {
    plan.storageProvider = runtime.storage.provider;
  }
  if (runtime.queue?.provider !== undefined) {
    plan.queueProvider = runtime.queue.provider;
  }
  if (runtime.logging?.level !== undefined) {
    plan.loggingLevel = runtime.logging.level;
  }

  return Object.freeze(plan);
}

function normalizeWorkspaceRoot(workspaceRoot: string | undefined, baseRoot: string): string {
  const absoluteBase = isAbsolute(baseRoot) ? baseRoot : resolve(baseRoot);
  if (workspaceRoot === undefined) {
    return absoluteBase;
  }

  return isAbsolute(workspaceRoot) ? workspaceRoot : resolve(absoluteBase, workspaceRoot);
}

function createPrimaryAgentPlan(
  config: GenericAIResolvedConfig,
  overrideAgentId: string | undefined,
): GenericAIAgentSessionPlan {
  const agentId = overrideAgentId ?? config.framework.primaryAgent;
  if (agentId !== undefined) {
    const agent = config.agents[agentId];
    if (agent === undefined) {
      throw new GenericAIConfigError({
        message: `Primary agent "${agentId}" is not defined in resolved config.`,
        failures: [
          {
            code: "MISSING_PRIMARY_AGENT",
            message: `Primary agent "${agentId}" is not defined in resolved config.`,
            suggestion: `Add ".generic-ai/agents/${agentId}.yaml" or choose an existing primaryAgent.`,
          },
        ],
      });
    }

    return normalizeAgentPlan(agentId, agent);
  }

  const [firstAgentId] = Object.keys(config.agents).sort();
  if (firstAgentId !== undefined) {
    return normalizeAgentPlan(firstAgentId, config.agents[firstAgentId]);
  }

  return Object.freeze({
    id: "primary",
    tools: Object.freeze([]),
    plugins: Object.freeze([]),
  });
}

function normalizeAgentPlan(
  agentId: string,
  agent: AgentConfig | undefined,
): GenericAIAgentSessionPlan {
  if (agent === undefined) {
    throw new GenericAIConfigError({
      message: `Agent "${agentId}" is not defined in resolved config.`,
      failures: [
        {
          code: "MISSING_AGENT",
          message: `Agent "${agentId}" is not defined in resolved config.`,
          suggestion: `Add ".generic-ai/agents/${agentId}.yaml" before using it for a runtime session.`,
        },
      ],
    });
  }

  const plan: {
    id: string;
    model?: string;
    instructions?: string;
    tools: readonly string[];
    plugins: readonly string[];
    memory?: NonNullable<AgentConfig["memory"]>;
  } = {
    id: agent.id || agentId,
    tools: Object.freeze([...(agent.tools ?? [])]),
    plugins: Object.freeze([...(agent.plugins ?? [])]),
  };

  if (agent.model !== undefined) {
    plan.model = agent.model;
  }
  if (agent.instructions !== undefined) {
    plan.instructions = agent.instructions;
  }
  if (agent.memory !== undefined) {
    plan.memory = Object.freeze({ ...agent.memory });
  }

  return Object.freeze(plan);
}

function createPluginInitPlans(
  config: GenericAIResolvedConfig,
): readonly GenericAIPluginInitPlan[] {
  return Object.freeze(
    Object.entries(config.plugins)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, plugin]) => createPluginInitPlan(namespace, plugin)),
  );
}

function createPluginInitPlan(namespace: string, plugin: PluginConfig): GenericAIPluginInitPlan {
  if (!isRecord(plugin)) {
    throw new GenericAIConfigError({
      message: `Plugin config namespace "${namespace}" must resolve to an object.`,
      failures: [
        {
          code: "PLUGIN_CONFIG_NOT_OBJECT",
          message: `Plugin config namespace "${namespace}" must resolve to an object.`,
          suggestion: `Update ".generic-ai/plugins/${namespace}.yaml" so it contains key-value pairs.`,
        },
      ],
    });
  }

  const raw = Object.freeze({ ...plugin }) as PluginConfig & Readonly<Record<string, unknown>>;
  const pluginId = normalizeOptionalString(raw.plugin) ?? namespace;
  const packageName = normalizeOptionalString(raw.package);
  const dependsOn = Array.isArray(raw.dependsOn)
    ? Object.freeze(
        raw.dependsOn.filter(
          (dependency: unknown): dependency is string => typeof dependency === "string",
        ),
      )
    : Object.freeze([]);
  const plan: {
    namespace: string;
    pluginId: string;
    packageName?: string;
    enabled: boolean;
    dependsOn: readonly string[];
    config: Readonly<Record<string, unknown>>;
    raw: PluginConfig & Readonly<Record<string, unknown>>;
  } = {
    namespace,
    pluginId,
    enabled: raw.enabled !== false,
    dependsOn,
    config: extractPluginOwnedConfig(raw),
    raw,
  };

  if (packageName !== undefined) {
    plan.packageName = packageName;
  }

  return Object.freeze(plan);
}

function extractPluginOwnedConfig(
  plugin: PluginConfig & Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (isRecord(plugin.config)) {
    return Object.freeze({ ...plugin.config });
  }

  const reserved = new Set(["plugin", "package", "enabled", "dependsOn", "metadata"]);
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(plugin)) {
    if (reserved.has(key)) {
      continue;
    }

    config[key] = value;
  }

  return Object.freeze(config);
}

function freezeResolvedConfig(config: GenericAIResolvedConfig): GenericAIResolvedConfig {
  return Object.freeze({
    ...config,
    agents: Object.freeze({ ...config.agents }),
    plugins: Object.freeze({ ...config.plugins }),
    ...(config.sources === undefined ? {} : { sources: cloneSources(config.sources) }),
  });
}

function cloneSources(sources: NonNullable<GenericAIResolvedConfig["sources"]>) {
  return {
    ...sources,
    ...(sources.agents === undefined ? {} : { agents: { ...sources.agents } }),
    ...(sources.plugins === undefined ? {} : { plugins: { ...sources.plugins } }),
    ...(sources.order === undefined ? {} : { order: [...sources.order] }),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
