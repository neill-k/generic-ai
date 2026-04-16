import {
  type BootstrapCapabilityId,
  type BootstrapPluginSlot,
  type BootstrapPluginSpec,
  type BootstrapPresetDefinition,
  type BootstrapPresetInput,
  createGenericAIFromConfig,
  createStarterPreset,
  type GenericAIConfiguredBootstrap,
  type GenericAIFromConfigOptions,
  type GenericAIRuntimeStarter,
  type GenericAIRuntimeStartResult,
} from "@generic-ai/core";
import { loadCanonicalConfig, type ValidationSchemaSource } from "@generic-ai/plugin-config-yaml";
import type { PresetContract } from "@generic-ai/sdk";

export const name = "@generic-ai/preset-starter-hono" as const;

export const STARTER_PRESET_ID = "preset.starter-hono";
export const STARTER_PRESET_VERSION = 1;

export type StarterPresetSlot =
  | "config"
  | "workspace"
  | "storage"
  | "queue"
  | "logging"
  | "terminalTools"
  | "fileTools"
  | "mcp"
  | "skills"
  | "delegation"
  | "messaging"
  | "memory"
  | "output"
  | "transport";

export interface StarterPresetSlotBinding {
  readonly slot: StarterPresetSlot;
  readonly pluginId: string;
  readonly required: boolean;
  readonly description: string;
}

export interface StarterPresetSlotOverride {
  readonly slot: StarterPresetSlot;
  readonly pluginId?: string;
  readonly enabled?: boolean;
  readonly description?: string;
}

export interface StarterPresetAddonPlugin {
  readonly pluginId: string;
  readonly anchorSlot: StarterPresetSlot;
  readonly insert: "before" | "after";
  readonly required?: boolean;
  readonly description?: string;
}

export interface StarterPresetResolutionOptions {
  readonly slotOverrides?: readonly StarterPresetSlotOverride[];
  readonly addons?: readonly StarterPresetAddonPlugin[];
}

export interface StarterPresetResolvedPlugin {
  readonly pluginId: string;
  readonly required: boolean;
  readonly source: "default" | "override" | "addon";
  readonly slot?: StarterPresetSlot;
  readonly anchorSlot?: StarterPresetSlot;
  readonly insert?: "before" | "after";
  readonly description?: string;
}

export interface StarterPresetResolvedContract {
  readonly id: string;
  readonly packageName: string;
  readonly version: number;
  readonly plugins: readonly StarterPresetResolvedPlugin[];
  readonly includesHono: boolean;
}

export interface StarterPresetContract
  extends PresetContract<StarterPresetResolvedContract, StarterPresetResolutionOptions> {
  readonly id: string;
  readonly packageName: string;
  readonly version: number;
  readonly description: string;
  readonly slots: readonly StarterPresetSlotBinding[];
  resolve(options?: StarterPresetResolutionOptions): StarterPresetResolvedContract;
}

export interface StarterHonoPresetOptions
  extends BootstrapPresetInput,
    StarterPresetResolutionOptions {}

export interface StarterHonoYamlBootstrapOptions<TRuntimeStart = GenericAIRuntimeStartResult>
  extends StarterHonoPresetOptions {
  readonly startDir: string;
  readonly schemaSource?: ValidationSchemaSource;
  readonly rejectUnknownPluginNamespaces?: boolean;
  readonly requireFramework?: boolean;
  readonly primaryAgentId?: string;
  readonly startRuntime?: GenericAIRuntimeStarter<TRuntimeStart>;
}

export interface StarterHonoPresetDefinition extends BootstrapPresetDefinition {
  readonly packageName: string;
  readonly version: number;
  readonly resolution: StarterPresetResolvedContract;
}

export const STARTER_PRESET_DEFAULT_SLOTS = [
  {
    slot: "config",
    pluginId: "@generic-ai/plugin-config-yaml",
    required: true,
    description: "Canonical config discovery and validation.",
  },
  {
    slot: "workspace",
    pluginId: "@generic-ai/plugin-workspace-fs",
    required: true,
    description: "Local-first workspace services.",
  },
  {
    slot: "storage",
    pluginId: "@generic-ai/plugin-storage-sqlite",
    required: true,
    description: "Durable local storage for v1.",
  },
  {
    slot: "queue",
    pluginId: "@generic-ai/plugin-queue-memory",
    required: true,
    description: "In-process async queue implementation.",
  },
  {
    slot: "logging",
    pluginId: "@generic-ai/plugin-logging-otel",
    required: true,
    description: "Structured logs and traces.",
  },
  {
    slot: "terminalTools",
    pluginId: "@generic-ai/plugin-tools-terminal",
    required: true,
    description: "Local terminal tooling.",
  },
  {
    slot: "fileTools",
    pluginId: "@generic-ai/plugin-tools-files",
    required: true,
    description: "Filesystem read/write/list/edit/search tools.",
  },
  {
    slot: "mcp",
    pluginId: "@generic-ai/plugin-mcp",
    required: true,
    description: "Embedded MCP support.",
  },
  {
    slot: "skills",
    pluginId: "@generic-ai/plugin-agent-skills",
    required: true,
    description: "Agent Skills integration.",
  },
  {
    slot: "delegation",
    pluginId: "@generic-ai/plugin-delegation",
    required: true,
    description: "Delegation semantics over kernel child sessions.",
  },
  {
    slot: "messaging",
    pluginId: "@generic-ai/plugin-messaging",
    required: true,
    description: "Durable inter-agent messaging.",
  },
  {
    slot: "memory",
    pluginId: "@generic-ai/plugin-memory-files",
    required: true,
    description: "File-backed persistent agent memory.",
  },
  {
    slot: "output",
    pluginId: "@generic-ai/plugin-output-default",
    required: true,
    description: "Default run finalization/output formatting.",
  },
  {
    slot: "transport",
    pluginId: "@generic-ai/plugin-hono",
    required: false,
    description: "Hono transport included by default in the starter path.",
  },
] as const satisfies readonly StarterPresetSlotBinding[];

interface InternalResolvedSlotBinding extends StarterPresetSlotBinding {
  readonly source: "default" | "override";
}

const slotToCapability = {
  workspace: "workspace",
  storage: "storage",
  queue: "queue",
  logging: "logging",
  terminalTools: "terminal-tools",
  fileTools: "file-tools",
  mcp: "mcp",
  skills: "skills",
  delegation: "delegation",
  messaging: "messaging",
  memory: "memory",
  output: "output",
} as const satisfies Partial<Record<StarterPresetSlot, BootstrapCapabilityId>>;

const dependencySlotsBySlot: Partial<Record<StarterPresetSlot, readonly StarterPresetSlot[]>> = {
  workspace: ["config"],
  storage: ["config"],
  queue: ["config"],
  logging: ["config"],
  terminalTools: ["workspace"],
  fileTools: ["workspace"],
  mcp: ["config"],
  skills: ["workspace"],
  delegation: ["queue"],
  messaging: ["storage"],
  memory: ["workspace"],
  output: ["config"],
  transport: ["output"],
};

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length > 0) {
    return;
  }

  throw new Error(`${label} must be a non-empty string.`);
}

function resolveSlotBindings(
  slotBindings: readonly StarterPresetSlotBinding[],
  overrides: readonly StarterPresetSlotOverride[],
): ReadonlyMap<StarterPresetSlot, InternalResolvedSlotBinding> {
  const resolved = new Map<StarterPresetSlot, InternalResolvedSlotBinding>();

  for (const slotBinding of slotBindings) {
    resolved.set(slotBinding.slot, { ...slotBinding, source: "default" });
  }

  const seenOverrideSlots = new Set<StarterPresetSlot>();

  for (const override of overrides) {
    if (seenOverrideSlots.has(override.slot)) {
      throw new Error(`Received more than one override for slot "${override.slot}".`);
    }

    seenOverrideSlots.add(override.slot);

    const current = resolved.get(override.slot);

    if (current === undefined) {
      throw new Error(`Unknown starter preset slot "${override.slot}".`);
    }

    if (override.enabled === false) {
      if (override.pluginId !== undefined) {
        throw new Error(
          `Slot override for "${override.slot}" sets "enabled: false" and "pluginId". Provide only one.`,
        );
      }

      if (current.required) {
        throw new Error(`Slot "${override.slot}" is required and cannot be disabled.`);
      }

      resolved.delete(override.slot);
      continue;
    }

    const nextPluginId = override.pluginId ?? current.pluginId;
    assertNonEmpty(nextPluginId, `slotOverrides[${override.slot}].pluginId`);

    resolved.set(override.slot, {
      ...current,
      pluginId: nextPluginId,
      description: override.description ?? current.description,
      source: "override",
    });
  }

  return resolved;
}

function resolveAddonsBySlot(
  addons: readonly StarterPresetAddonPlugin[],
  resolvedSlots: ReadonlyMap<StarterPresetSlot, InternalResolvedSlotBinding>,
): {
  readonly before: ReadonlyMap<StarterPresetSlot, readonly StarterPresetResolvedPlugin[]>;
  readonly after: ReadonlyMap<StarterPresetSlot, readonly StarterPresetResolvedPlugin[]>;
} {
  const before = new Map<StarterPresetSlot, StarterPresetResolvedPlugin[]>();
  const after = new Map<StarterPresetSlot, StarterPresetResolvedPlugin[]>();

  for (const addon of addons) {
    assertNonEmpty(addon.pluginId, "addons[].pluginId");

    if (!resolvedSlots.has(addon.anchorSlot)) {
      throw new Error(
        `Addon plugin "${addon.pluginId}" targets slot "${addon.anchorSlot}", but that slot is not active.`,
      );
    }

    const bucket = addon.insert === "before" ? before : after;
    const existing = bucket.get(addon.anchorSlot);
    const plugin: StarterPresetResolvedPlugin = {
      pluginId: addon.pluginId,
      required: addon.required ?? false,
      source: "addon",
      anchorSlot: addon.anchorSlot,
      insert: addon.insert,
    };

    const pluginWithDescription =
      addon.description === undefined ? plugin : { ...plugin, description: addon.description };

    if (existing === undefined) {
      bucket.set(addon.anchorSlot, [pluginWithDescription]);
      continue;
    }

    bucket.set(addon.anchorSlot, [...existing, pluginWithDescription]);
  }

  return { before, after };
}

function createResolvedStarterPreset(
  slotBindings: readonly StarterPresetSlotBinding[],
  options: StarterPresetResolutionOptions | undefined,
): StarterPresetResolvedContract {
  const slotOverrides = options?.slotOverrides ?? [];
  const addons = options?.addons ?? [];
  const resolvedSlots = resolveSlotBindings(slotBindings, slotOverrides);
  const addonsBySlot = resolveAddonsBySlot(addons, resolvedSlots);

  const plugins: StarterPresetResolvedPlugin[] = [];

  for (const slotBinding of slotBindings) {
    const resolvedSlot = resolvedSlots.get(slotBinding.slot);

    if (resolvedSlot === undefined) {
      continue;
    }

    const before = addonsBySlot.before.get(slotBinding.slot) ?? [];
    const after = addonsBySlot.after.get(slotBinding.slot) ?? [];

    plugins.push(...before);
    plugins.push({
      pluginId: resolvedSlot.pluginId,
      required: resolvedSlot.required,
      source: resolvedSlot.source,
      slot: resolvedSlot.slot,
      description: resolvedSlot.description,
    });
    plugins.push(...after);
  }

  return {
    id: STARTER_PRESET_ID,
    packageName: name,
    version: STARTER_PRESET_VERSION,
    plugins,
    includesHono: plugins.some((plugin) => plugin.pluginId === "@generic-ai/plugin-hono"),
  };
}

function resolveCapabilitiesFromContract(
  resolution: StarterPresetResolvedContract,
): ReadonlyArray<BootstrapCapabilityId> {
  const capabilities = new Set<BootstrapCapabilityId>();

  for (const plugin of resolution.plugins) {
    if (plugin.slot === undefined) {
      continue;
    }

    const capability =
      plugin.slot in slotToCapability
        ? slotToCapability[plugin.slot as keyof typeof slotToCapability]
        : undefined;
    if (capability !== undefined) {
      capabilities.add(capability);
    }
  }

  // Only advertise the Hono transport capability when the resolved plugin set
  // actually contains `@generic-ai/plugin-hono`; a slot override can keep the
  // transport slot enabled while swapping the underlying plugin, in which case
  // this preset must not pretend Hono is available to downstream bootstrap
  // consumers.
  if (resolution.includesHono) {
    capabilities.add("transport-hono");
  }

  return [...capabilities];
}

function resolveBootstrapPluginSpecs(
  resolution: StarterPresetResolvedContract,
): readonly BootstrapPluginSpec[] {
  const pluginIdBySlot = new Map<StarterPresetSlot, string>();

  for (const plugin of resolution.plugins) {
    if (plugin.slot !== undefined) {
      pluginIdBySlot.set(plugin.slot, plugin.pluginId);
    }
  }

  return Object.freeze(
    resolution.plugins.map((plugin) => {
      const dependencies =
        plugin.slot === undefined
          ? plugin.insert === "after" && plugin.anchorSlot !== undefined
            ? [pluginIdBySlot.get(plugin.anchorSlot)].filter(
                (pluginId): pluginId is string => pluginId !== undefined,
              )
            : plugin.anchorSlot === undefined
              ? []
              : (dependencySlotsBySlot[plugin.anchorSlot] ?? [])
                  .map((slot) => pluginIdBySlot.get(slot))
                  .filter((pluginId): pluginId is string => pluginId !== undefined)
          : (dependencySlotsBySlot[plugin.slot] ?? [])
              .map((slot) => pluginIdBySlot.get(slot))
              .filter((pluginId): pluginId is string => pluginId !== undefined);

      return Object.freeze({
        pluginId: plugin.pluginId,
        required: plugin.required,
        source: plugin.source,
        ...(plugin.slot === undefined ? {} : { slot: plugin.slot as BootstrapPluginSlot }),
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
        ...(dependencies.length === 0 ? {} : { dependencies: Object.freeze(dependencies) }),
      });
    }),
  );
}

export const starterPresetContract: StarterPresetContract = {
  id: STARTER_PRESET_ID,
  packageName: name,
  version: STARTER_PRESET_VERSION,
  description:
    "Default local-first Generic AI starter preset contract with Hono included by default and programmatic extension points.",
  slots: STARTER_PRESET_DEFAULT_SLOTS,
  resolve(options?: StarterPresetResolutionOptions): StarterPresetResolvedContract {
    return createResolvedStarterPreset(STARTER_PRESET_DEFAULT_SLOTS, options);
  },
};

export function resolveStarterPreset(
  options?: StarterPresetResolutionOptions,
): StarterPresetResolvedContract {
  return starterPresetContract.resolve(options);
}

function deriveCapabilitiesFromPluginSpecs(
  plugins: readonly BootstrapPluginSpec[],
): ReadonlyArray<BootstrapCapabilityId> {
  const capabilities = new Set<BootstrapCapabilityId>();

  for (const plugin of plugins) {
    if (plugin.slot === undefined) {
      continue;
    }

    const capability =
      plugin.slot in slotToCapability
        ? slotToCapability[plugin.slot as keyof typeof slotToCapability]
        : undefined;
    if (capability !== undefined) {
      capabilities.add(capability);
    }
  }

  if (plugins.some((p) => p.pluginId === "@generic-ai/plugin-hono")) {
    capabilities.add("transport-hono");
  }

  return [...capabilities];
}

export function createStarterHonoPreset(
  options: StarterHonoPresetOptions = {},
): StarterHonoPresetDefinition {
  const resolution = resolveStarterPreset(options);
  const hasExplicitPlugins = options.plugins !== undefined;
  const effectivePlugins = options.plugins ?? resolveBootstrapPluginSpecs(resolution);
  const effectiveIncludesHono = hasExplicitPlugins
    ? effectivePlugins.some((p) => p.pluginId === "@generic-ai/plugin-hono")
    : resolution.includesHono;

  // Default the bootstrap preset id to the package name so it stays aligned
  // with core's `createStarterPreset` (which uses the package name as its id).
  // STARTER_PRESET_ID remains the contract-level identifier used by tests and
  // preset consumers that read the contract directly.
  const bootstrap = createStarterPreset({
    id: options.id ?? name,
    name: options.name ?? "Starter Hono preset",
    description: options.description ?? starterPresetContract.description,
    transport: options.transport ?? (effectiveIncludesHono ? "hono" : "custom"),
    capabilities:
      options.capabilities ??
      (hasExplicitPlugins
        ? deriveCapabilitiesFromPluginSpecs(effectivePlugins)
        : resolveCapabilitiesFromContract(resolution)),
    plugins: effectivePlugins,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  });

  return Object.freeze({
    ...bootstrap,
    packageName: name,
    version: STARTER_PRESET_VERSION,
    resolution,
  });
}

export const starterHonoPreset = createStarterHonoPreset();

export async function createStarterHonoBootstrapFromYaml<
  TRuntimeStart = GenericAIRuntimeStartResult,
>(
  options: StarterHonoYamlBootstrapOptions<TRuntimeStart>,
): Promise<GenericAIConfiguredBootstrap<TRuntimeStart>> {
  const {
    startDir,
    schemaSource,
    rejectUnknownPluginNamespaces,
    requireFramework,
    primaryAgentId,
    startRuntime,
    ...presetOptions
  } = options;
  const preset = createStarterHonoPreset(presetOptions);
  const configSource: {
    startDir: string;
    load: NonNullable<
      GenericAIFromConfigOptions<ValidationSchemaSource, TRuntimeStart>["configSource"]
    >["load"];
    schemaSource?: ValidationSchemaSource;
    rejectUnknownPluginNamespaces?: boolean;
    requireFramework?: boolean;
  } = {
    startDir,
    load: async (loadStartDir, loadOptions) => loadCanonicalConfig(loadStartDir, loadOptions),
  };

  if (schemaSource !== undefined) {
    configSource.schemaSource = schemaSource;
  }
  if (rejectUnknownPluginNamespaces !== undefined) {
    configSource.rejectUnknownPluginNamespaces = rejectUnknownPluginNamespaces;
  }
  if (requireFramework !== undefined) {
    configSource.requireFramework = requireFramework;
  }

  return createGenericAIFromConfig({
    preset,
    configSource,
    ...(primaryAgentId === undefined ? {} : { primaryAgentId }),
    ...(startRuntime === undefined ? {} : { startRuntime }),
  });
}
