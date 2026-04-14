import type {
  GenericAIBootstrapOptions,
  GenericAIBootstrapResult,
  PresetContract,
  ResolvedConfig,
} from "@generic-ai/sdk";

export const name = "@generic-ai/core";

export interface GenericAIInstance<TPreset = PresetContract> extends GenericAIBootstrapResult<TPreset> {
  readonly kind: "generic-ai-instance";
  readonly resolvedPreset?: unknown;
}

export function createGenericAI<TPreset extends PresetContract | undefined = PresetContract>(
  options: GenericAIBootstrapOptions<TPreset> = {},
): GenericAIInstance<TPreset> {
  const rootScopeId = options.rootScopeId ?? "root";
  const resolvedPreset = resolvePreset(options.preset);

  return {
    kind: "generic-ai-instance",
    packageName: name,
    createdAt: new Date().toISOString(),
    rootScopeId,
    ...(options.config ? { config: options.config as ResolvedConfig } : {}),
    ...(options.preset ? { preset: options.preset } : {}),
    ...(resolvedPreset !== undefined ? { resolvedPreset } : {}),
  };
}

function resolvePreset(preset: PresetContract | undefined): unknown {
  if (!preset || typeof preset.resolve !== "function") {
    return undefined;
  }

  try {
    return preset.resolve();
  } catch {
    return undefined;
  }
}
