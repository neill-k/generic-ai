import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type {
  AgentConfig,
  OutputEnvelope,
  OutputFinalizeInput,
  OutputPluginContract,
  PluginConfig,
  RunEnvelope,
} from "@generic-ai/sdk";
import { createCanonicalEventStream } from "../events/index.js";
import {
  createPluginHost,
  type PluginDefinition,
  type PluginLifecyclePhase,
  type PluginManifest,
} from "../plugin-host/index.js";
import { createRunEnvelope, finalizeRunEnvelope } from "../run-envelope/index.js";
import { createRootScope } from "../scope/index.js";
import {
  resolveStarterCapabilities,
  resolveStarterPorts,
  starterPreset,
} from "./starter-preset.js";
import type {
  BootstrapCapabilityId,
  BootstrapLifecycleEvent,
  BootstrapPluginConfig,
  BootstrapPluginInstance,
  BootstrapPluginSource,
  BootstrapPluginSpec,
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
  GenericAIRunContext,
  GenericAIRuntimePlan,
  GenericAIRuntimeSettingsPlan,
  GenericAIRuntimeStarterInput,
  GenericAIRuntimeStartResult,
  GenericAIRunTask,
  GenericAIStreamChunk,
} from "./types.js";

const BOOTSTRAP_ROOT_AGENT_ID = "generic-ai-bootstrap";
const DEFAULT_OUTPUT_PLUGIN_ID = "@generic-ai/plugin-output-default";

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

function freezePluginSpec(spec: BootstrapPluginSpec): BootstrapPluginSpec {
  return Object.freeze({
    ...spec,
    ...(spec.dependencies === undefined
      ? {}
      : { dependencies: Object.freeze([...spec.dependencies]) }),
    ...(spec.config === undefined ? {} : { config: Object.freeze({ ...spec.config }) }),
  });
}

function resolvePresetPlugins(
  input: readonly BootstrapPluginSpec[] | undefined,
): readonly BootstrapPluginSpec[] {
  return Object.freeze([...(input ?? starterPreset.plugins)].map(freezePluginSpec));
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
    plugins: resolvePresetPlugins(base.plugins),
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

function normalizePluginSource(source: BootstrapPluginSpec["source"]): BootstrapPluginSource {
  return source ?? "custom";
}

function freezePluginConfig(
  spec: BootstrapPluginSpec,
  override: BootstrapPluginConfig | undefined,
): BootstrapPluginConfig {
  return Object.freeze({
    ...(spec.config ?? {}),
    ...(override ?? {}),
    ...(spec.slot === undefined ? {} : { slot: spec.slot }),
    required: spec.required ?? false,
    source: normalizePluginSource(spec.source),
  });
}

function createLifecycleRecorder(
  lifecycleEvents: BootstrapLifecycleEvent[],
  now: () => string,
): (pluginId: string, phase: PluginLifecyclePhase) => void {
  return (pluginId, phase) => {
    lifecycleEvents.push(
      Object.freeze({
        pluginId,
        phase,
        occurredAt: now(),
      }),
    );
  };
}

function createPluginDefinition(
  spec: BootstrapPluginSpec,
  recordLifecycle: (pluginId: string, phase: PluginLifecyclePhase) => void,
): PluginDefinition {
  const manifestInput: PluginManifest = {
    id: spec.pluginId,
    ...(spec.dependencies === undefined ? {} : { dependencies: spec.dependencies }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.slot === undefined ? {} : { slot: spec.slot }),
    required: spec.required ?? false,
    source: normalizePluginSource(spec.source),
  };

  return Object.freeze({
    manifest: Object.freeze(manifestInput),
    lifecycle: Object.freeze({
      setup: () => recordLifecycle(spec.pluginId, "setup"),
      start: () => recordLifecycle(spec.pluginId, "start"),
      stop: () => recordLifecycle(spec.pluginId, "stop"),
    }),
  });
}

function instantiatePlugin(
  spec: BootstrapPluginSpec,
  configOverride: BootstrapPluginConfig | undefined,
  recordLifecycle: (pluginId: string, phase: PluginLifecyclePhase) => void,
): BootstrapPluginInstance {
  const config = freezePluginConfig(spec, configOverride);
  const definition = createPluginDefinition(spec, recordLifecycle);

  return Object.freeze({
    pluginId: definition.manifest.id,
    ...(spec.slot === undefined ? {} : { slot: spec.slot }),
    required: spec.required ?? false,
    source: normalizePluginSource(spec.source),
    config,
    definition,
  });
}

function composePlugins(
  preset: BootstrapPresetDefinition,
  ports: BootstrapPorts,
  options: Pick<GenericAIOptions, "pluginConfig" | "now">,
) {
  const now = options.now ?? (() => new Date().toISOString());
  const host = createPluginHost();
  const lifecycleEvents: BootstrapLifecycleEvent[] = [];
  const recordLifecycle = createLifecycleRecorder(lifecycleEvents, now);
  const instancesById = new Map<string, BootstrapPluginInstance>();

  for (const spec of preset.plugins) {
    const instance = instantiatePlugin(
      spec,
      options.pluginConfig?.[spec.pluginId],
      recordLifecycle,
    );
    const registered = host.register(instance.definition);
    instancesById.set(
      registered.manifest.id,
      Object.freeze({
        ...instance,
        pluginId: registered.manifest.id,
        definition: registered,
      }),
    );
  }

  const orderedInstances = Object.freeze(
    host.resolveOrder().map((definition) => {
      const instance = instancesById.get(definition.manifest.id);
      if (instance === undefined) {
        throw new Error(`Plugin "${definition.manifest.id}" was ordered without an instance.`);
      }

      return instance;
    }),
  );
  const pluginConfigs = Object.freeze(
    Object.fromEntries(orderedInstances.map((instance) => [instance.pluginId, instance.config])),
  ) as Readonly<Record<string, BootstrapPluginConfig>>;
  const pluginOrder = Object.freeze(orderedInstances.map((instance) => instance.pluginId));

  return {
    host,
    plugins: orderedInstances,
    surfaces: Object.freeze({
      pluginHost: host,
      pluginOrder,
      pluginConfigs,
      ports,
      lifecycle: Object.freeze({
        events: () => Object.freeze([...lifecycleEvents]),
      }),
    }),
  };
}

function createBootstrapOutputPlugin(pluginId: string): OutputPluginContract<unknown, unknown> {
  return Object.freeze({
    kind: "output-plugin",
    manifest: Object.freeze({
      kind: "plugin",
      id: pluginId,
      name: pluginId,
    }),
    contentType: "application/json",
    finalize(input: OutputFinalizeInput<unknown>) {
      const payload = input.run;
      const envelope = {
        kind: "output-envelope",
        pluginId: input.pluginId,
        contentType: "application/json",
        payload,
        summary: summarizeOutput(payload),
        metadata: Object.freeze({
          scopeId: input.scopeId,
          ...(input.context ?? {}),
        }),
      } satisfies OutputEnvelope<unknown>;

      return Object.freeze(envelope);
    },
  });
}

function summarizeOutput(value: unknown): string {
  if (typeof value === "string") {
    return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
    }
  } catch {
    // Fall through to a stable fallback for non-JSON payloads.
  }

  return String(value);
}

function toFailurePayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return Object.freeze({
      error: Object.freeze({
        name: error.name,
        message: error.message,
      }),
    });
  }

  return Object.freeze({
    error: String(error),
  });
}

function resolveOutputPluginId(plugins: readonly BootstrapPluginInstance[]): string {
  return plugins.find((plugin) => plugin.slot === "output")?.pluginId ?? DEFAULT_OUTPUT_PLUGIN_ID;
}

async function evaluateTask<TOutput>(
  task: GenericAIRunTask<TOutput>,
  context: GenericAIRunContext,
): Promise<TOutput> {
  if (typeof task === "function") {
    return (task as (context: GenericAIRunContext) => TOutput | Promise<TOutput>)(context);
  }

  return task;
}

function createRunEventInput(
  name: "run.created" | "run.started" | "run.completed" | "run.failed",
  context: {
    readonly runId: string;
    readonly rootScopeId: string;
    readonly rootSessionId: string;
  },
  data: Record<string, unknown>,
) {
  return {
    name,
    runId: context.runId,
    scopeId: context.rootScopeId,
    rootSessionId: context.rootSessionId,
    sessionId: context.rootSessionId,
    origin: {
      namespace: "core" as const,
      subsystem: "bootstrap",
    },
    data,
  };
}

export function createGenericAI(options: GenericAIOptions = {}): GenericAIBootstrap {
  const now = options.now ?? (() => new Date().toISOString());
  const createRunId = options.createRunId ?? randomUUID;
  const capabilities = resolveStarterCapabilities(
    options.capabilities ?? options.preset?.capabilities,
  );
  const ports = resolvePorts(resolveStarterPorts(options.preset?.ports), options.ports);
  const preset = resolvePreset(options.preset, capabilities, ports);
  const composition = composePlugins(preset, ports, {
    ...(options.pluginConfig === undefined ? {} : { pluginConfig: options.pluginConfig }),
    now,
  });
  const outputPlugin = createBootstrapOutputPlugin(resolveOutputPluginId(composition.plugins));

  let startupState: "idle" | "starting" | "started" = "idle";
  let startupPromise: Promise<void> | undefined;
  let runtime: GenericAIBootstrap;

  async function stopRuntime(): Promise<void> {
    if (startupState !== "started") {
      return;
    }

    await composition.host.runLifecycle("stop", {
      presetId: preset.id,
      transport: preset.transport,
    });
    startupState = "idle";
    startupPromise = undefined;
  }

  async function ensureStarted(): Promise<void> {
    if (startupState === "started") {
      return;
    }

    if (startupPromise !== undefined) {
      return startupPromise;
    }

    startupState = "starting";
    startupPromise = (async () => {
      await composition.host.runLifecycle("setup", {
        presetId: preset.id,
        transport: preset.transport,
      });
      await composition.host.runLifecycle("start", {
        presetId: preset.id,
        transport: preset.transport,
      });
      startupState = "started";
    })();

    try {
      await startupPromise;
    } catch (error) {
      startupState = "idle";
      startupPromise = undefined;
      throw error;
    }
  }

  async function executeRun<TOutput>(
    task: GenericAIRunTask<TOutput>,
  ): Promise<RunEnvelope<TOutput>> {
    await ensureStarted();

    const runId = createRunId();
    const scope = createRootScope({
      kind: "runtime",
      label: preset.name,
      metadata: {
        presetId: preset.id,
      },
    });
    const rootSessionId = `${runId}:root`;
    const eventStream = createCanonicalEventStream({ now });
    const streamId = `${runId}:events`;
    const createdAt = now();
    await eventStream.emit(
      createRunEventInput(
        "run.created",
        { runId, rootScopeId: scope.rootId, rootSessionId },
        { presetId: preset.id },
      ),
    );
    const startedAt = now();
    await eventStream.emit(
      createRunEventInput(
        "run.started",
        { runId, rootScopeId: scope.rootId, rootSessionId },
        { pluginOrder: composition.surfaces.pluginOrder },
      ),
    );
    const runningEnvelope = createRunEnvelope<TOutput>({
      runId,
      rootScopeId: scope.rootId,
      rootAgentId: BOOTSTRAP_ROOT_AGENT_ID,
      mode: "async",
      status: "running",
      timestamps: { createdAt, startedAt },
      eventStream: {
        kind: "event-stream-reference",
        streamId,
        sequence: eventStream.snapshot().length,
      },
    });

    try {
      const result = await evaluateTask(task, {
        runId,
        scope,
        runtime,
        surfaces: composition.surfaces,
      });
      const completedAt = now();
      await eventStream.emit(
        createRunEventInput(
          "run.completed",
          { runId, rootScopeId: scope.rootId, rootSessionId },
          { outputPluginId: outputPlugin.manifest.id },
        ),
      );

      return finalizeRunEnvelope({
        envelope: {
          ...runningEnvelope,
          eventStream: {
            kind: "event-stream-reference" as const,
            streamId,
            sequence: eventStream.snapshot().length,
          },
        },
        outputPlugin: outputPlugin as OutputPluginContract<TOutput, TOutput>,
        run: result,
        status: "succeeded",
        completedAt,
        context: {
          pluginOrder: composition.surfaces.pluginOrder,
        },
      });
    } catch (error) {
      const completedAt = now();
      const failure = toFailurePayload(error);
      await eventStream.emit(
        createRunEventInput(
          "run.failed",
          { runId, rootScopeId: scope.rootId, rootSessionId },
          failure,
        ),
      );

      return finalizeRunEnvelope({
        envelope: {
          ...runningEnvelope,
          eventStream: {
            kind: "event-stream-reference" as const,
            streamId,
            sequence: eventStream.snapshot().length,
          },
        },
        outputPlugin: outputPlugin as OutputPluginContract<Record<string, unknown>, TOutput>,
        run: failure,
        status: "failed",
        completedAt,
        context: {
          pluginOrder: composition.surfaces.pluginOrder,
        },
      });
    }
  }

  async function* streamRun<TOutput>(
    task: GenericAIRunTask<TOutput>,
  ): AsyncIterable<GenericAIStreamChunk<TOutput>> {
    await ensureStarted();

    const runId = createRunId();
    const scope = createRootScope({
      kind: "runtime",
      label: preset.name,
      metadata: {
        presetId: preset.id,
      },
    });
    const rootSessionId = `${runId}:root`;
    const eventStream = createCanonicalEventStream({ now });
    const streamId = `${runId}:events`;
    const createdAt = now();
    const created = await eventStream.emit(
      createRunEventInput(
        "run.created",
        { runId, rootScopeId: scope.rootId, rootSessionId },
        { presetId: preset.id },
      ),
    );
    yield { type: "event", event: created };

    const startedAt = now();
    const started = await eventStream.emit(
      createRunEventInput(
        "run.started",
        { runId, rootScopeId: scope.rootId, rootSessionId },
        { pluginOrder: composition.surfaces.pluginOrder },
      ),
    );
    yield { type: "event", event: started };

    const runningEnvelope = createRunEnvelope<TOutput>({
      runId,
      rootScopeId: scope.rootId,
      rootAgentId: BOOTSTRAP_ROOT_AGENT_ID,
      mode: "async",
      status: "running",
      timestamps: { createdAt, startedAt },
      eventStream: {
        kind: "event-stream-reference",
        streamId,
        sequence: eventStream.snapshot().length,
      },
    });

    try {
      const result = await evaluateTask(task, {
        runId,
        scope,
        runtime,
        surfaces: composition.surfaces,
      });
      const completedAt = now();
      const completed = await eventStream.emit(
        createRunEventInput(
          "run.completed",
          { runId, rootScopeId: scope.rootId, rootSessionId },
          { outputPluginId: outputPlugin.manifest.id },
        ),
      );
      yield { type: "event", event: completed };

      const envelope = await finalizeRunEnvelope({
        envelope: {
          ...runningEnvelope,
          eventStream: {
            kind: "event-stream-reference" as const,
            streamId,
            sequence: eventStream.snapshot().length,
          },
        },
        outputPlugin: outputPlugin as OutputPluginContract<TOutput, TOutput>,
        run: result,
        status: "succeeded",
        completedAt,
        context: {
          pluginOrder: composition.surfaces.pluginOrder,
        },
      });
      yield { type: "envelope", envelope };
    } catch (error) {
      const completedAt = now();
      const failure = toFailurePayload(error);
      const failed = await eventStream.emit(
        createRunEventInput(
          "run.failed",
          { runId, rootScopeId: scope.rootId, rootSessionId },
          failure,
        ),
      );
      yield { type: "event", event: failed };

      const envelope = await finalizeRunEnvelope({
        envelope: {
          ...runningEnvelope,
          eventStream: {
            kind: "event-stream-reference" as const,
            streamId,
            sequence: eventStream.snapshot().length,
          },
        },
        outputPlugin: outputPlugin as OutputPluginContract<Record<string, unknown>, TOutput>,
        run: failure,
        status: "failed",
        completedAt,
        context: {
          pluginOrder: composition.surfaces.pluginOrder,
        },
      });
      yield { type: "envelope", envelope };
    }
  }

  runtime = Object.freeze({
    preset,
    capabilities,
    ports,
    pluginHost: composition.host,
    plugins: composition.plugins,
    surfaces: composition.surfaces,
    describe: () =>
      `${preset.name} [${preset.id}] with ${preset.capabilities.length} capabilities via ${preset.transport}`,
    run: executeRun,
    stream: streamRun,
    stop: stopRuntime,
  });

  return runtime;
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
    pluginHost: composition.pluginHost,
    plugins: composition.plugins,
    surfaces: composition.surfaces,
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

  let result: Awaited<ReturnType<typeof source.load>>;
  try {
    result = await source.load(source.startDir, loadOptions);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Config loader threw an unexpected error.";
    throw new GenericAIConfigError({
      message: `Config loader failed: ${message}`,
      failures: [
        {
          code: "CONFIG_LOADER_EXCEPTION",
          message,
          suggestion: "Check that the config source loader is correctly implemented.",
        },
      ],
    });
  }

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

  if (result.failures !== undefined && result.failures.length > 0) {
    throw new GenericAIConfigError({
      message: summarizeConfigLoadFailure(result.failures, result.diagnostics),
      ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
      failures: result.failures,
    });
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
  const presetPlugins = preset?.plugins ?? starterPreset.plugins;
  const pluginConfigFromConfig = resolveConfigPluginOverrides(config, presetPlugins);
  const pluginConfig =
    options.pluginConfig === undefined
      ? pluginConfigFromConfig
      : Object.freeze({
          ...(pluginConfigFromConfig ?? {}),
          ...options.pluginConfig,
        });

  return {
    ...(preset === undefined ? {} : { preset }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(pluginConfig === undefined ? {} : { pluginConfig }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
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

function buildShortNameToPresetIdMap(
  presetPlugins: readonly BootstrapPluginSpec[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();

  for (const spec of presetPlugins) {
    const lastSegment = spec.pluginId.split("/").pop() ?? spec.pluginId;
    const shortName = lastSegment.startsWith("plugin-")
      ? lastSegment.slice("plugin-".length)
      : lastSegment;
    mapping.set(shortName, spec.pluginId);
  }

  return mapping;
}

function resolveConfigPluginOverrides(
  config: GenericAIResolvedConfig,
  presetPlugins: readonly BootstrapPluginSpec[],
): Readonly<Record<string, BootstrapPluginConfig>> | undefined {
  const plans = createPluginInitPlans(config);
  if (plans.length === 0) {
    return undefined;
  }

  const shortNameMap = buildShortNameToPresetIdMap(presetPlugins);

  return Object.freeze(
    Object.fromEntries(
      plans.map((plan) => {
        let resolvedId = plan.pluginId;
        if (!resolvedId.startsWith("@")) {
          const fullId = shortNameMap.get(resolvedId);
          if (fullId !== undefined) {
            resolvedId = fullId;
          }
        }

        return [
          resolvedId,
          Object.freeze({
            namespace: plan.namespace,
            enabled: plan.enabled,
            dependsOn: Object.freeze([...plan.dependsOn]),
            ...(plan.packageName === undefined ? {} : { packageName: plan.packageName }),
            ...plan.config,
          }),
        ];
      }),
    ),
  ) as Readonly<Record<string, BootstrapPluginConfig>>;
}

function extractPluginOwnedConfig(
  plugin: PluginConfig & Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (isRecord(plugin.config)) {
    return Object.freeze({ ...plugin.config });
  }

  if (plugin.config !== undefined) {
    throw new GenericAIConfigError({
      message: `Plugin "config" field must be an object when present.`,
      failures: [
        {
          code: "PLUGIN_CONFIG_NOT_OBJECT",
          message: `Plugin "config" field must be an object when present, got ${typeof plugin.config}.`,
          suggestion: `Use a nested object under "config:" or spread top-level keys instead.`,
        },
      ],
    });
  }

  const reserved = new Set(["plugin", "package", "enabled", "dependsOn", "metadata", "config"]);
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(plugin)) {
    if (reserved.has(key)) {
      continue;
    }

    config[key] = value;
  }

  return Object.freeze(config);
}

/**
 * Shallow-freezes the top-level resolved config and its `agents`/`plugins` maps.
 * The `framework` and `sources` fields are deep-frozen via dedicated helpers so
 * that nested runtime, storage, queue, and logging sub-objects are also immutable.
 * Other nested objects (individual agent/plugin values) remain mutable references;
 * callers that need full immutability should deep-freeze the entire tree.
 */
function freezeResolvedConfig(config: GenericAIResolvedConfig): GenericAIResolvedConfig {
  return Object.freeze({
    ...config,
    framework: deepFreezeFramework(config.framework),
    agents: Object.freeze({ ...config.agents }),
    plugins: Object.freeze({ ...config.plugins }),
    ...(config.sources === undefined
      ? {}
      : { sources: deepFreezeSources(config.sources) }),
  });
}

function deepFreezeFramework(
  framework: GenericAIResolvedConfig["framework"],
): GenericAIResolvedConfig["framework"] {
  const runtime = framework.runtime;
  const frozenRuntime =
    runtime === undefined
      ? undefined
      : Object.freeze({
          ...runtime,
          ...(runtime.storage === undefined ? {} : { storage: Object.freeze({ ...runtime.storage }) }),
          ...(runtime.queue === undefined ? {} : { queue: Object.freeze({ ...runtime.queue }) }),
          ...(runtime.logging === undefined
            ? {}
            : { logging: Object.freeze({ ...runtime.logging }) }),
        });

  return Object.freeze({
    ...framework,
    ...(frozenRuntime === undefined ? {} : { runtime: frozenRuntime }),
    ...(framework.metadata === undefined
      ? {}
      : { metadata: Object.freeze({ ...framework.metadata }) }),
    ...(framework.plugins === undefined
      ? {}
      : { plugins: [...framework.plugins] }),
  });
}

function deepFreezeSources(
  sources: NonNullable<GenericAIResolvedConfig["sources"]>,
): NonNullable<GenericAIResolvedConfig["sources"]> {
  return Object.freeze({
    ...sources,
    ...(sources.agents === undefined ? {} : { agents: Object.freeze({ ...sources.agents }) }),
    ...(sources.plugins === undefined ? {} : { plugins: Object.freeze({ ...sources.plugins }) }),
    ...(sources.order === undefined ? {} : { order: [...sources.order] }),
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
