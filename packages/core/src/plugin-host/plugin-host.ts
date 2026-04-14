import { createRegistry } from "../registries/index.js";
import { PluginHostError, type DuplicatePluginIdIssue, type PluginHostIssue } from "./errors.js";
import { resolvePluginOrder } from "./dependency-order.js";
import type {
  PluginDefinition,
  PluginHost,
  PluginHostRegistries,
  PluginLifecyclePhase,
  PluginManifest,
} from "./types.js";

function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (normalized.length === 0) {
    throw new PluginHostError({
      code: "invalid-plugin-manifest",
      field: "id",
      message: "Plugin manifest ids must be non-empty strings.",
    });
  }

  return normalized;
}

function normalizeDependencies(pluginId: string, dependencies: unknown): readonly string[] | undefined {
  if (dependencies === undefined) {
    return undefined;
  }

  if (!Array.isArray(dependencies)) {
    throw new PluginHostError({
      code: "invalid-plugin-manifest",
      field: "dependencies",
      pluginId,
      message: `Plugin "${pluginId}" declares dependencies with a non-array value.`,
    });
  }

  const normalizedDependencies: string[] = [];
  const seen = new Set<string>();

  for (const dependency of dependencies) {
    if (typeof dependency !== "string") {
      throw new PluginHostError({
        code: "invalid-plugin-manifest",
        field: "dependencies",
        pluginId,
        message: `Plugin "${pluginId}" depends on a non-string value.`,
      });
    }

    const normalizedDependency = normalizePluginId(dependency);
    if (normalizedDependency === pluginId) {
      throw new PluginHostError({
        code: "invalid-plugin-manifest",
        field: "dependencies",
        pluginId,
        message: `Plugin "${pluginId}" cannot depend on itself.`,
      });
    }

    if (seen.has(normalizedDependency)) {
      throw new PluginHostError({
        code: "invalid-plugin-manifest",
        field: "dependencies",
        pluginId,
        message: `Plugin "${pluginId}" lists "${normalizedDependency}" more than once in its dependencies.`,
      });
    }

    seen.add(normalizedDependency);
    normalizedDependencies.push(normalizedDependency);
  }

  return normalizedDependencies.length > 0 ? Object.freeze(normalizedDependencies) : undefined;
}

export function validatePluginManifest(manifest: unknown): PluginManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new PluginHostError({
      code: "invalid-plugin-manifest",
      field: "manifest",
      message: "Plugin manifests must be objects.",
    });
  }

  const candidate = manifest as Record<string, unknown>;
  const rawId = candidate["id"];
  if (typeof rawId !== "string") {
    throw new PluginHostError({
      code: "invalid-plugin-manifest",
      field: "id",
      message: "Plugin manifests must include a string `id`.",
    });
  }

  const id = normalizePluginId(rawId);
  const dependencies = normalizeDependencies(id, candidate["dependencies"]);

  return Object.freeze({
    ...candidate,
    id,
    ...(dependencies === undefined ? {} : { dependencies }),
  }) as PluginManifest;
}

export function createPluginHost(): PluginHost {
  const plugins = createRegistry<PluginDefinition>("plugins");
  const manifests = createRegistry<PluginManifest>("manifests");

  const registries: PluginHostRegistries = {
    plugins,
    manifests,
  };

  const register = (plugin: PluginDefinition): PluginDefinition => {
    const manifest = validatePluginManifest(plugin.manifest);
    if (plugins.has(manifest.id)) {
      throw new PluginHostError({
        code: "duplicate-plugin-id",
        pluginId: manifest.id,
        message: `Plugin "${manifest.id}" was registered more than once.`,
      } satisfies DuplicatePluginIdIssue);
    }

    const normalizedPlugin: PluginDefinition = Object.freeze({
      manifest,
      ...(plugin.lifecycle === undefined ? {} : { lifecycle: plugin.lifecycle }),
    });

    plugins.register(manifest.id, normalizedPlugin);
    manifests.register(manifest.id, manifest);

    return normalizedPlugin;
  };

  const list = (): readonly PluginDefinition[] => plugins.values();

  const resolveOrder = (): readonly PluginDefinition[] => resolvePluginOrder(list());

  const validate = (): readonly PluginHostIssue[] => {
    try {
      resolvePluginOrder(list());
      return [];
    } catch (error) {
      if (error instanceof PluginHostError) {
        return error.issues;
      }

      throw error;
    }
  };

  const runLifecycle = async (phase: PluginLifecyclePhase, state: Record<string, unknown> = {}): Promise<void> => {
    const orderedPlugins = phase === "stop" ? [...resolveOrder()].reverse() : resolveOrder();
    const context = {
      host,
      registries,
      state: Object.freeze({ ...state }),
    } as const;

    for (const plugin of orderedPlugins) {
      const hook = plugin.lifecycle?.[phase];
      if (hook === undefined) {
        continue;
      }

      await hook(context);
    }
  };

  const host: PluginHost = {
    registries,
    register,
    list,
    resolveOrder,
    validate,
    runLifecycle,
  };

  return host;
}
