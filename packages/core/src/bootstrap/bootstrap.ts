import type {
  BootstrapCapabilityId,
  BootstrapPortDescriptor,
  BootstrapPortOverrides,
  BootstrapPorts,
  BootstrapPresetDefinition,
  BootstrapPresetInput,
  GenericAIBootstrap,
  GenericAIOptions,
} from "./types.js";
import {
  resolveStarterCapabilities,
  resolveStarterPorts,
  starterPreset,
} from "./starter-preset.js";

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
