export type StarterHonoCapabilityId =
  | "workspace"
  | "storage"
  | "queue"
  | "logging"
  | "terminal-tools"
  | "file-tools"
  | "mcp"
  | "skills"
  | "delegation"
  | "messaging"
  | "memory"
  | "output"
  | "transport-hono";

export interface StarterHonoPortDescriptor {
  readonly module: string;
  readonly symbol: string;
  readonly status: "expected" | "provided";
  readonly note?: string;
}

export interface StarterHonoPorts {
  readonly pluginHost: StarterHonoPortDescriptor;
  readonly runMode: StarterHonoPortDescriptor;
  readonly runEnvelope: StarterHonoPortDescriptor;
  readonly piBoundary: StarterHonoPortDescriptor;
}

export type StarterHonoPortOverrides = {
  readonly [Key in keyof StarterHonoPorts]?: Partial<StarterHonoPorts[Key]>;
};

export interface StarterHonoPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly transport: string;
  readonly capabilities: ReadonlyArray<StarterHonoCapabilityId>;
  readonly ports: StarterHonoPorts;
}

export interface StarterHonoPresetInput {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly transport?: string;
  readonly capabilities?: ReadonlyArray<StarterHonoCapabilityId>;
  readonly ports?: StarterHonoPortOverrides;
}

const starterCapabilities: ReadonlyArray<StarterHonoCapabilityId> = Object.freeze([
  "workspace",
  "storage",
  "queue",
  "logging",
  "terminal-tools",
  "file-tools",
  "mcp",
  "skills",
  "delegation",
  "messaging",
  "memory",
  "output",
  "transport-hono",
]);

const starterPorts: StarterHonoPorts = Object.freeze({
  pluginHost: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createPluginHost",
    status: "expected",
    note: "Bootstrap resolves the plugin host through the core port boundary.",
  }),
  runMode: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createSyncRunMode",
    status: "expected",
    note: "The starter preset assumes the core run-mode layer will wire the adapter.",
  }),
  runEnvelope: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createRunEnvelope",
    status: "expected",
    note: "The envelope contract stays external to the preset package.",
  }),
  piBoundary: Object.freeze({
    module: "@generic-ai/sdk",
    symbol: "pi",
    status: "expected",
    note: "The SDK boundary remains the source of truth for the primitive contract.",
  }),
});

function mergePort(
  base: StarterHonoPortDescriptor,
  override: Partial<StarterHonoPortDescriptor> | undefined,
): StarterHonoPortDescriptor {
  if (override === undefined) {
    return base;
  }

  return Object.freeze({
    ...base,
    ...override,
  });
}

function mergePorts(overrides: StarterHonoPortOverrides | undefined): StarterHonoPorts {
  if (overrides === undefined) {
    return starterPorts;
  }

  return Object.freeze({
    pluginHost: mergePort(starterPorts.pluginHost, overrides.pluginHost),
    runMode: mergePort(starterPorts.runMode, overrides.runMode),
    runEnvelope: mergePort(starterPorts.runEnvelope, overrides.runEnvelope),
    piBoundary: mergePort(starterPorts.piBoundary, overrides.piBoundary),
  });
}

export const name = "@generic-ai/preset-starter-hono";

export function createStarterHonoPreset(
  input: StarterHonoPresetInput = {},
): StarterHonoPreset {
  return Object.freeze({
    id: input.id ?? name,
    name: input.name ?? "Starter Hono preset",
    description:
      input.description ??
      "Default local-first starter preset with Hono in the default path.",
    transport: input.transport ?? "hono",
    capabilities: Object.freeze([...(input.capabilities ?? starterCapabilities)]),
    ports: mergePorts(input.ports),
  });
}

export const starterHonoPreset: StarterHonoPreset = createStarterHonoPreset();
