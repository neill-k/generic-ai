import {
  type ComposedConfigSchema,
  type ComposedPluginNamespaceSchema,
  type ConfigPathSegment,
  formatConfigPath,
  type PluginSchemaRegistry,
  type SchemaProvenance,
  type ZodIssueLike,
  type ZodSafeParseResult,
} from "./registry.js";

export type ConfigValidationDiagnosticCode =
  | "PLUGINS_CONFIG_NOT_OBJECT"
  | "ROOT_CONFIG_NOT_OBJECT"
  | "SCHEMA_VALIDATION_FAILED"
  | "UNKNOWN_PLUGIN_NAMESPACE";

export interface ConfigValidationDiagnostic {
  readonly code: ConfigValidationDiagnosticCode;
  readonly issueCode?: string;
  readonly message: string;
  readonly namespace?: string;
  readonly path: string;
  readonly pathSegments: readonly ConfigPathSegment[];
  readonly pluginIds: readonly string[];
  readonly provenance: readonly SchemaProvenance[];
}

export interface StartupValidationOptions {
  readonly rejectUnknownPluginNamespaces?: boolean;
}

export interface StartupValidationResult {
  readonly diagnostics: readonly ConfigValidationDiagnostic[];
  readonly ok: boolean;
}

export type ValidationSchemaSource = ComposedConfigSchema | Pick<PluginSchemaRegistry, "compose">;

export class ConfigValidationError extends Error {
  readonly diagnostics: readonly ConfigValidationDiagnostic[];

  constructor(diagnostics: readonly ConfigValidationDiagnostic[]) {
    super(formatConfigValidationDiagnostics(diagnostics));
    this.name = "ConfigValidationError";
    this.diagnostics = diagnostics;
  }
}

export function validateConfigAtStartup(
  config: unknown,
  schemaSource: ValidationSchemaSource,
  options: StartupValidationOptions = {},
): StartupValidationResult {
  const rejectUnknownPluginNamespaces = options.rejectUnknownPluginNamespaces ?? true;
  const composed = resolveComposedSchema(schemaSource);
  const diagnostics: ConfigValidationDiagnostic[] = [];

  if (!isRecord(config)) {
    diagnostics.push(
      createDiagnostic({
        code: "ROOT_CONFIG_NOT_OBJECT",
        message: `Expected root config object, received ${describeValue(config)}.`,
        pathSegments: [],
      }),
    );
    return { ok: false, diagnostics };
  }

  const { plugins: pluginsValue } = config;
  if (pluginsValue !== undefined && !isRecord(pluginsValue)) {
    diagnostics.push(
      createDiagnostic({
        code: "PLUGINS_CONFIG_NOT_OBJECT",
        message: `Expected "plugins" config to be an object, received ${describeValue(pluginsValue)}.`,
        pathSegments: ["plugins"],
      }),
    );
    return { ok: false, diagnostics };
  }

  const pluginConfig = (pluginsValue ?? {}) as Record<string, unknown>;
  if (rejectUnknownPluginNamespaces) {
    const knownNamespaces = new Set(composed.namespaces.map((entry) => entry.namespace));
    for (const namespace of Object.keys(pluginConfig)) {
      if (knownNamespaces.has(namespace)) {
        continue;
      }

      diagnostics.push(
        createDiagnostic({
          code: "UNKNOWN_PLUGIN_NAMESPACE",
          message: `No schema fragment registered for plugins namespace "${namespace}".`,
          namespace,
          pathSegments: ["plugins", namespace],
        }),
      );
    }
  }

  for (const entry of composed.namespaces) {
    if (!(entry.namespace in pluginConfig)) {
      continue;
    }

    const namespaceValue = pluginConfig[entry.namespace];
    const parsed = safeParseNoThrow(entry, namespaceValue);
    if (parsed.success) {
      continue;
    }

    for (const issue of parsed.error.issues) {
      const relativePath = issue.path ?? [];
      const fullPath = ["plugins", entry.namespace, ...relativePath];
      diagnostics.push(
        createDiagnostic({
          code: "SCHEMA_VALIDATION_FAILED",
          issueCode: issue.code,
          message: issue.message,
          namespace: entry.namespace,
          pathSegments: fullPath,
          provenance: entry.provenance,
        }),
      );
    }
  }

  return {
    diagnostics,
    ok: diagnostics.length === 0,
  };
}

export function assertValidConfigAtStartup(
  config: unknown,
  schemaSource: ValidationSchemaSource,
  options: StartupValidationOptions = {},
): void {
  const result = validateConfigAtStartup(config, schemaSource, options);
  if (!result.ok) {
    throw new ConfigValidationError(result.diagnostics);
  }
}

export function formatConfigValidationDiagnostics(
  diagnostics: readonly ConfigValidationDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "Config validation passed.";
  }

  const lines = ["Config validation failed:"];
  for (const [index, diagnostic] of diagnostics.entries()) {
    const namespace = diagnostic.namespace ? ` [namespace=${diagnostic.namespace}]` : "";
    const issue = diagnostic.issueCode ? ` [issue=${diagnostic.issueCode}]` : "";
    const pluginSummary =
      diagnostic.pluginIds.length > 0 ? ` [plugins=${diagnostic.pluginIds.join(", ")}]` : "";
    const sourceSummary = formatSourceSummary(diagnostic.provenance);
    lines.push(
      `${index + 1}. ${diagnostic.path}${namespace}${issue}${pluginSummary}${sourceSummary}: ${diagnostic.message}`,
    );
  }

  return lines.join("\n");
}

function createDiagnostic(input: {
  code: ConfigValidationDiagnosticCode;
  issueCode?: string;
  message: string;
  namespace?: string;
  pathSegments: readonly ConfigPathSegment[];
  provenance?: readonly SchemaProvenance[];
}): ConfigValidationDiagnostic {
  const provenance = input.provenance ? [...input.provenance] : [];
  const pluginIds = [...new Set(provenance.map((entry) => entry.pluginId))].sort();
  return {
    code: input.code,
    message: input.message,
    path: formatConfigPath(input.pathSegments),
    pathSegments: [...input.pathSegments],
    pluginIds,
    provenance,
    ...(input.issueCode !== undefined ? { issueCode: input.issueCode } : {}),
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
  };
}

function resolveComposedSchema(source: ValidationSchemaSource): ComposedConfigSchema {
  if ("namespaces" in source && "namespaceLookup" in source) {
    return source;
  }
  return source.compose();
}

function safeParseNoThrow(
  namespaceEntry: ComposedPluginNamespaceSchema,
  value: unknown,
): ZodSafeParseResult<unknown> {
  try {
    return namespaceEntry.schema.safeParse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: {
        issues: [
          {
            code: "schema_parse_threw",
            message: `Schema parse threw for namespace "${namespaceEntry.namespace}": ${message}`,
            path: [],
          },
        ],
      },
    };
  }
}

function formatSourceSummary(provenance: readonly SchemaProvenance[]): string {
  const sources = [
    ...new Set(provenance.map((entry) => entry.source).filter((source) => Boolean(source))),
  ];
  if (sources.length === 0) {
    return "";
  }

  return ` [sources=${sources.join(", ")}]`;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { ZodIssueLike };
