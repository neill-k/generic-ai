import type {
  BootstrapCapabilityId,
  BootstrapPortOverrides,
  BootstrapPluginSpec,
  BootstrapPorts,
  BootstrapPresetDefinition,
  BootstrapPresetInput,
} from "./types.js";

const starterCapabilities: ReadonlyArray<BootstrapCapabilityId> = Object.freeze([
  "workspace",
  "storage",
  "queue",
  "logging",
  "terminal-tools",
  "file-tools",
  "repo-map",
  "lsp",
  "mcp",
  "skills",
  "delegation",
  "messaging",
  "memory",
  "output",
  "transport-hono",
]);

/**
 * Approved bootstrap exception: core keeps a mirrored starter descriptor so
 * bare `createGenericAI()` calls can resolve the starter path without
 * importing preset or plugin packages directly.
 */
const starterPluginSpecs: readonly BootstrapPluginSpec[] = Object.freeze([
  Object.freeze({
    slot: "config",
    pluginId: "@generic-ai/plugin-config-yaml",
    required: true,
    source: "default",
    description: "Canonical config discovery and validation.",
  }),
  Object.freeze({
    slot: "workspace",
    pluginId: "@generic-ai/plugin-workspace-fs",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "Local-first workspace services.",
  }),
  Object.freeze({
    slot: "storage",
    pluginId: "@generic-ai/plugin-storage-sqlite",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "Durable local storage for the starter path.",
  }),
  Object.freeze({
    slot: "queue",
    pluginId: "@generic-ai/plugin-queue-memory",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "In-process async queue implementation.",
  }),
  Object.freeze({
    slot: "logging",
    pluginId: "@generic-ai/plugin-logging-otel",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "Structured logs and traces.",
  }),
  Object.freeze({
    slot: "terminalTools",
    pluginId: "@generic-ai/plugin-tools-terminal",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "Local terminal tooling.",
  }),
  Object.freeze({
    slot: "fileTools",
    pluginId: "@generic-ai/plugin-tools-files",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "Filesystem read/write/list/edit/search tools.",
  }),
  Object.freeze({
    slot: "repoMap",
    pluginId: "@generic-ai/plugin-repo-map",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "Deterministic compact repository orientation tools.",
  }),
  Object.freeze({
    slot: "lsp",
    pluginId: "@generic-ai/plugin-lsp",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "Language-server diagnostics, symbols, definitions, and references.",
  }),
  Object.freeze({
    slot: "mcp",
    pluginId: "@generic-ai/plugin-mcp",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "Embedded MCP support.",
  }),
  Object.freeze({
    slot: "skills",
    pluginId: "@generic-ai/plugin-agent-skills",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "Agent Skills integration.",
  }),
  Object.freeze({
    slot: "delegation",
    pluginId: "@generic-ai/plugin-delegation",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-queue-memory"]),
    description: "Delegation semantics over kernel child sessions.",
  }),
  Object.freeze({
    slot: "messaging",
    pluginId: "@generic-ai/plugin-messaging",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-storage-sqlite"]),
    description: "Durable inter-agent messaging.",
  }),
  Object.freeze({
    slot: "memory",
    pluginId: "@generic-ai/plugin-memory-files",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-workspace-fs"]),
    description: "File-backed persistent agent memory.",
  }),
  Object.freeze({
    slot: "output",
    pluginId: "@generic-ai/plugin-output-default",
    required: true,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-config-yaml"]),
    description: "Default run finalization/output formatting.",
  }),
  Object.freeze({
    slot: "transport",
    pluginId: "@generic-ai/plugin-hono",
    required: false,
    source: "default",
    dependencies: Object.freeze(["@generic-ai/plugin-output-default"]),
    description: "Hono transport included by default in the starter path.",
  }),
]);

const starterPorts: BootstrapPorts = Object.freeze({
  pluginHost: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createPluginHost",
    status: "provided",
    note: "Core composes starter plugins through the plugin host during bootstrap.",
  }),
  runMode: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createAsyncRunMode",
    status: "provided",
    note: "The bootstrap runtime evaluates tasks asynchronously via run(task) and stream(task).",
  }),
  runEnvelope: Object.freeze({
    module: "@generic-ai/core",
    symbol: "createRunEnvelope",
    status: "provided",
    note: "Core creates canonical run envelopes for bootstrap run and stream calls.",
  }),
  piBoundary: Object.freeze({
    module: "@generic-ai/sdk",
    symbol: "pi",
    status: "expected",
    note: "The bootstrap layer expects the SDK boundary, not a kernel-owned reimplementation.",
  }),
});

const freezeBootstrapPorts = (ports: BootstrapPortOverrides | undefined): BootstrapPorts => {
  if (ports === undefined) {
    return starterPorts;
  }

  return Object.freeze({
    pluginHost: Object.freeze({ ...starterPorts.pluginHost, ...(ports.pluginHost ?? {}) }),
    runMode: Object.freeze({ ...starterPorts.runMode, ...(ports.runMode ?? {}) }),
    runEnvelope: Object.freeze({ ...starterPorts.runEnvelope, ...(ports.runEnvelope ?? {}) }),
    piBoundary: Object.freeze({ ...starterPorts.piBoundary, ...(ports.piBoundary ?? {}) }),
  });
};

function freezePluginSpecs(
  specs: readonly BootstrapPluginSpec[] | undefined,
): readonly BootstrapPluginSpec[] {
  return Object.freeze(
    (specs ?? starterPluginSpecs).map((spec) => {
      const frozenSpec: BootstrapPluginSpec = Object.freeze({
        ...spec,
        ...(spec.dependencies === undefined
          ? {}
          : { dependencies: Object.freeze([...spec.dependencies]) }),
        ...(spec.config === undefined ? {} : { config: Object.freeze({ ...spec.config }) }),
      });

      return frozenSpec;
    }),
  );
}

export function createStarterPreset(input: BootstrapPresetInput = {}): BootstrapPresetDefinition {
  return Object.freeze({
    id: input.id ?? "@generic-ai/preset-starter-hono",
    name: input.name ?? "Starter Hono preset",
    description:
      input.description ?? "Default local-first preset that keeps Hono in the starter path.",
    transport: input.transport ?? "hono",
    capabilities: Object.freeze([...(input.capabilities ?? starterCapabilities)]),
    ports: freezeBootstrapPorts(input.ports),
    plugins: freezePluginSpecs(input.plugins),
  });
}

export const starterPreset: BootstrapPresetDefinition = createStarterPreset();

export const starterPortsDefinition: BootstrapPorts = starterPorts;
export const starterPluginDefinitions: readonly BootstrapPluginSpec[] = starterPluginSpecs;

export function resolveStarterPorts(overrides: BootstrapPortOverrides | undefined): BootstrapPorts {
  return freezeBootstrapPorts(overrides);
}

export function resolveStarterCapabilities(
  overrides: ReadonlyArray<BootstrapCapabilityId> | undefined,
): ReadonlyArray<BootstrapCapabilityId> {
  return Object.freeze([...(overrides ?? starterCapabilities)]);
}
