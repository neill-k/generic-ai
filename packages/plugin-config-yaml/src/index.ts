import type { ResolvedConfig } from "@generic-ai/sdk";

import {
  formatConfigValidationDiagnostics,
  type ConfigValidationDiagnostic,
  type StartupValidationOptions,
  validateConfigAtStartup,
  type ValidationSchemaSource,
} from "./validation.js";
import {
  resolveCanonicalConfig,
  type ConfigLoadFailure,
  type ResolveCanonicalConfigOptions,
} from "./resolution.js";

export const name = "@generic-ai/plugin-config-yaml";

export * from "./discovery.js";
export * from "./registry.js";
export * from "./resolution.js";
export * from "./validation.js";

export interface LoadCanonicalConfigOptions
  extends ResolveCanonicalConfigOptions,
    StartupValidationOptions {
  readonly schemaSource?: ValidationSchemaSource;
}

export type LoadCanonicalConfigResult =
  | {
      readonly ok: true;
      readonly config: ResolvedConfig;
      readonly diagnostics: readonly ConfigValidationDiagnostic[];
      readonly failures: readonly ConfigLoadFailure[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ConfigValidationDiagnostic[];
      readonly failures: readonly ConfigLoadFailure[];
    };

export async function loadCanonicalConfig(
  startDir: string,
  options: LoadCanonicalConfigOptions = {},
): Promise<LoadCanonicalConfigResult> {
  const resolution = await resolveCanonicalConfig(startDir, options);

  if (!resolution.ok) {
    return {
      ok: false,
      diagnostics: [],
      failures: resolution.failures,
    };
  }

  const config = resolution.config as unknown as ResolvedConfig;

  if (!options.schemaSource) {
    return {
      ok: true,
      config,
      diagnostics: [],
      failures: [],
    };
  }

  const diagnostics = validateConfigAtStartup(config, options.schemaSource, options).diagnostics;
  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
      failures: [],
    };
  }

  return {
    ok: true,
    config,
    diagnostics,
    failures: [],
  };
}

export async function assertCanonicalConfig(
  startDir: string,
  options: LoadCanonicalConfigOptions = {},
): Promise<ResolvedConfig> {
  const result = await loadCanonicalConfig(startDir, options);
  if (!result.ok) {
    if (result.failures.length > 0) {
      throw new Error(result.failures.map((failure) => failure.message).join("\n"));
    }

    throw new Error(formatConfigValidationDiagnostics(result.diagnostics));
  }

  return result.config;
}
