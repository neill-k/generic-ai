import type {
  BootstrapCapabilityId,
  BootstrapPortDescriptor,
  BootstrapPortOverrides,
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
  "mcp",
  "skills",
  "delegation",
  "messaging",
  "memory",
  "output",
  "transport-hono",
]);

const starterPorts: BootstrapPorts = Object.freeze({
  pluginHost: Object.freeze({
    module: "@generic-ai/core/plugin-host",
    symbol: "createPluginHost",
    status: "expected",
    note: "Core owns the plugin-host port; the runtime implementation is still being wired.",
  }),
  runMode: Object.freeze({
    module: "@generic-ai/core/run-modes",
    symbol: "createSyncRunMode",
    status: "expected",
    note: "The bootstrap layer only needs the run-mode port contract for now.",
  }),
  runEnvelope: Object.freeze({
    module: "@generic-ai/core/run-envelope",
    symbol: "createRunEnvelope",
    status: "expected",
    note: "The envelope contract is intentionally described as a port until the upstream module lands.",
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

export function createStarterPreset(
  input: BootstrapPresetInput = {},
): BootstrapPresetDefinition {
  return Object.freeze({
    id: input.id ?? "@generic-ai/preset-starter-hono",
    name: input.name ?? "Starter Hono preset",
    description:
      input.description ??
      "Default local-first preset that keeps Hono in the starter path.",
    transport: input.transport ?? "hono",
    capabilities: Object.freeze([...(input.capabilities ?? starterCapabilities)]),
    ports: freezeBootstrapPorts(input.ports),
  });
}

export const starterPreset: BootstrapPresetDefinition = createStarterPreset();

export const starterPortsDefinition: BootstrapPorts = starterPorts;

export function resolveStarterPorts(overrides: BootstrapPortOverrides | undefined): BootstrapPorts {
  return freezeBootstrapPorts(overrides);
}

export function resolveStarterCapabilities(
  overrides: ReadonlyArray<BootstrapCapabilityId> | undefined,
): ReadonlyArray<BootstrapCapabilityId> {
  return Object.freeze([...(overrides ?? starterCapabilities)]);
}
