export type ConfigPathSegment = number | string;

export interface ZodIssueLike {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly ConfigPathSegment[];
}

export interface ZodErrorLike {
  readonly issues: readonly ZodIssueLike[];
}

export type ZodSafeParseResult<T> =
  | {
      readonly data: T;
      readonly success: true;
    }
  | {
      readonly error: ZodErrorLike;
      readonly success: false;
    };

export interface ZodSchemaLike<T = unknown> {
  safeParse(input: unknown): ZodSafeParseResult<T>;
}

export interface ZodComposableSchemaLike<T = unknown> extends ZodSchemaLike<T> {
  and?(other: ZodSchemaLike<unknown>): ZodSchemaLike<unknown>;
  merge?(other: ZodComposableSchemaLike<unknown>): ZodComposableSchemaLike<unknown>;
}

export interface SchemaProvenance {
  readonly fragmentIndex: number;
  readonly jsonSchema?: unknown;
  readonly pluginId: string;
  readonly source?: string;
}

export interface PluginSchemaFragment {
  readonly jsonSchema?: unknown;
  readonly namespace?: string;
  readonly pluginId: string;
  readonly schema: ZodSchemaLike<unknown>;
  readonly source?: string;
}

export interface RegisteredPluginSchemaFragment extends SchemaProvenance {
  readonly namespace: string;
  readonly schema: ZodSchemaLike<unknown>;
}

export interface ComposedPluginNamespaceSchema {
  readonly namespace: string;
  readonly provenance: readonly SchemaProvenance[];
  readonly schema: ZodSchemaLike<unknown>;
}

export interface ComposedConfigSchema {
  readonly namespaceLookup: Readonly<Record<string, ComposedPluginNamespaceSchema>>;
  readonly namespaces: readonly ComposedPluginNamespaceSchema[];
}

export type SchemaRegistryErrorCode = "INVALID_FRAGMENT" | "SCHEMA_CONFLICT";

export class SchemaRegistryError extends Error {
  readonly code: SchemaRegistryErrorCode;
  readonly namespace?: string;
  readonly pluginId?: string;

  constructor(input: {
    code: SchemaRegistryErrorCode;
    message: string;
    namespace?: string;
    pluginId?: string;
  }) {
    super(input.message);
    this.name = "SchemaRegistryError";
    this.code = input.code;
    if (input.namespace !== undefined) {
      this.namespace = input.namespace;
    }
    if (input.pluginId !== undefined) {
      this.pluginId = input.pluginId;
    }
  }
}

interface WorkingNamespace {
  readonly namespace: string;
  readonly provenance: SchemaProvenance[];
  readonly schemas: ZodSchemaLike<unknown>[];
}

export class PluginSchemaRegistry {
  readonly #fragments: RegisteredPluginSchemaFragment[] = [];

  clear(): void {
    this.#fragments.length = 0;
  }

  list(): readonly RegisteredPluginSchemaFragment[] {
    return this.#fragments.map((fragment) => ({ ...fragment }));
  }

  register(fragmentOrFragments: PluginSchemaFragment | readonly PluginSchemaFragment[]): this {
    const next = Array.isArray(fragmentOrFragments) ? fragmentOrFragments : [fragmentOrFragments];
    for (const fragment of next) {
      this.#fragments.push(this.#prepareFragment(fragment));
    }
    return this;
  }

  compose(): ComposedConfigSchema {
    const grouped = new Map<string, WorkingNamespace>();

    for (const fragment of this.#fragments) {
      const bucket = grouped.get(fragment.namespace);
      if (!bucket) {
        grouped.set(fragment.namespace, {
          namespace: fragment.namespace,
          provenance: [toProvenance(fragment)],
          schemas: [fragment.schema],
        });
        continue;
      }

      bucket.provenance.push(toProvenance(fragment));
      bucket.schemas.push(fragment.schema);
    }

    const namespaces: ComposedPluginNamespaceSchema[] = [];
    for (const [namespace, group] of grouped.entries()) {
      namespaces.push({
        namespace,
        provenance: group.provenance.sort((left, right) => left.fragmentIndex - right.fragmentIndex),
        schema: composeNamespaceSchemas(namespace, group.schemas, group.provenance),
      });
    }

    namespaces.sort((left, right) => left.namespace.localeCompare(right.namespace));
    const namespaceLookup: Record<string, ComposedPluginNamespaceSchema> = {};
    for (const namespace of namespaces) {
      namespaceLookup[namespace.namespace] = namespace;
    }

    return {
      namespaces,
      namespaceLookup,
    };
  }

  #prepareFragment(fragment: PluginSchemaFragment): RegisteredPluginSchemaFragment {
    const pluginId = fragment.pluginId.trim();
    if (!pluginId) {
      throw new SchemaRegistryError({
        code: "INVALID_FRAGMENT",
        message: "Schema fragment pluginId must be a non-empty string.",
      });
    }

    if (!isSchemaLike(fragment.schema)) {
      throw new SchemaRegistryError({
        code: "INVALID_FRAGMENT",
        message: `Schema fragment for plugin "${pluginId}" must expose a safeParse(input) function.`,
        pluginId,
      });
    }

    const namespace = normalizeNamespace(fragment.namespace ?? deriveNamespaceFromPluginId(pluginId), {
      pluginId,
      context: "fragment namespace",
    });

    const source = fragment.source?.trim() || undefined;
    return {
      fragmentIndex: this.#fragments.length,
      namespace,
      pluginId,
      schema: fragment.schema,
      ...(fragment.jsonSchema !== undefined ? { jsonSchema: fragment.jsonSchema } : {}),
      ...(source !== undefined ? { source } : {}),
    };
  }
}

export function createPluginSchemaRegistry(): PluginSchemaRegistry {
  return new PluginSchemaRegistry();
}

export function deriveNamespaceFromPluginId(pluginId: string): string {
  const trimmed = pluginId.trim().toLowerCase();
  const slashIndex = trimmed.indexOf("/");
  const packageName = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  const withoutPluginPrefix = packageName.startsWith("plugin-") ? packageName.slice("plugin-".length) : packageName;

  return normalizeNamespace(withoutPluginPrefix, {
    pluginId,
    context: "derived namespace",
  });
}

export function formatConfigPath(path: readonly ConfigPathSegment[]): string {
  if (path.length === 0) {
    return "$";
  }

  let rendered = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) {
      rendered += `.${segment}`;
      continue;
    }

    rendered += `["${segment.replaceAll('"', '\\"')}"]`;
  }

  return rendered;
}

function composeNamespaceSchemas(
  namespace: string,
  schemas: readonly ZodSchemaLike<unknown>[],
  provenance: readonly SchemaProvenance[],
): ZodSchemaLike<unknown> {
  const [first, ...rest] = schemas;
  if (!first) {
    return createSequentialSchema(namespace, schemas);
  }

  let composed = first;
  for (const next of rest) {
    composed = composeTwoSchemas(namespace, composed, next, provenance);
  }

  return composed;
}

function composeTwoSchemas(
  namespace: string,
  left: ZodSchemaLike<unknown>,
  right: ZodSchemaLike<unknown>,
  provenance: readonly SchemaProvenance[],
): ZodSchemaLike<unknown> {
  const leftComposable = left as ZodComposableSchemaLike<unknown>;
  const rightComposable = right as ZodComposableSchemaLike<unknown>;

  if (typeof leftComposable.merge === "function" && typeof rightComposable.merge === "function") {
    try {
      return leftComposable.merge(rightComposable);
    } catch (error) {
      throw buildComposeConflict(namespace, provenance, "merge", error);
    }
  }

  if (typeof leftComposable.and === "function") {
    try {
      return leftComposable.and(right);
    } catch (error) {
      throw buildComposeConflict(namespace, provenance, "and", error);
    }
  }

  return createSequentialSchema(namespace, [left, right]);
}

function createSequentialSchema(namespace: string, schemas: readonly ZodSchemaLike<unknown>[]): ZodSchemaLike<unknown> {
  return {
    safeParse(input: unknown): ZodSafeParseResult<unknown> {
      let current: unknown = input;
      const issues: ZodIssueLike[] = [];

      for (const schema of schemas) {
        const result = safeParseNoThrow(schema, current, namespace);
        if (result.success) {
          current = result.data;
          continue;
        }
        issues.push(...result.error.issues);
      }

      if (issues.length > 0) {
        return {
          success: false,
          error: {
            issues,
          },
        };
      }

      return {
        success: true,
        data: current,
      };
    },
  };
}

function safeParseNoThrow(
  schema: ZodSchemaLike<unknown>,
  input: unknown,
  namespace: string,
): ZodSafeParseResult<unknown> {
  try {
    const parsed = schema.safeParse(input);
    if (isSafeParseResult(parsed)) {
      return parsed;
    }

    return {
      success: false,
      error: {
        issues: [
          {
            code: "invalid_safeparse_result",
            message: `Schema for namespace "${namespace}" returned an invalid safeParse result.`,
            path: [],
          },
        ],
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: {
        issues: [
          {
            code: "schema_parse_threw",
            message: `Schema for namespace "${namespace}" threw during safeParse: ${message}`,
            path: [],
          },
        ],
      },
    };
  }
}

function buildComposeConflict(
  namespace: string,
  provenance: readonly SchemaProvenance[],
  strategy: "and" | "merge",
  cause: unknown,
): SchemaRegistryError {
  const plugins = [...new Set(provenance.map((entry) => entry.pluginId))].sort();
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new SchemaRegistryError({
    code: "SCHEMA_CONFLICT",
    message: `Failed to compose namespace "${namespace}" via ${strategy} for plugins ${plugins.join(", ")}. ${detail}`,
    namespace,
  });
}

function normalizeNamespace(
  rawNamespace: string,
  context: {
    context: string;
    pluginId: string;
  },
): string {
  const normalized = rawNamespace
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new SchemaRegistryError({
      code: "INVALID_FRAGMENT",
      message: `Could not derive a deterministic namespace from "${rawNamespace}" (${context.context}) for plugin "${context.pluginId}".`,
      pluginId: context.pluginId,
    });
  }

  return normalized;
}

function toProvenance(fragment: RegisteredPluginSchemaFragment): SchemaProvenance {
  return {
    fragmentIndex: fragment.fragmentIndex,
    pluginId: fragment.pluginId,
    ...(fragment.jsonSchema !== undefined ? { jsonSchema: fragment.jsonSchema } : {}),
    ...(fragment.source !== undefined ? { source: fragment.source } : {}),
  };
}

function isSchemaLike(value: unknown): value is ZodSchemaLike<unknown> {
  return typeof value === "object" && value !== null && "safeParse" in value && typeof value.safeParse === "function";
}

function isSafeParseResult(value: unknown): value is ZodSafeParseResult<unknown> {
  if (typeof value !== "object" || value === null || !("success" in value)) {
    return false;
  }

  if (value.success === true) {
    return "data" in value;
  }

  return value.success === false && "error" in value;
}
