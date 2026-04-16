import { randomUUID } from "node:crypto";
import type {
  OutputEnvelope,
  OutputFinalizeInput,
  OutputPluginContract,
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
  GenericAIBootstrap,
  GenericAIOptions,
  GenericAIRunContext,
  GenericAIRunTask,
  GenericAIStreamChunk,
} from "./types.js";
import {
  resolveStarterCapabilities,
  resolveStarterPorts,
  starterPreset,
} from "./starter-preset.js";

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
