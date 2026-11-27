import type { PluginDefinition, PluginManifest } from "./types.js";
import {
  PluginHostError,
  type CyclicPluginDependencyIssue,
  type MissingPluginDependencyIssue,
  type PluginHostIssue,
} from "./errors.js";

interface ResolvedPlugin {
  readonly plugin: PluginDefinition;
  readonly index: number;
}

function getNormalizedDependencies(manifest: PluginManifest): readonly string[] {
  return manifest.dependencies ?? [];
}

function findCycle(definitions: readonly ResolvedPlugin[]): readonly string[] {
  const pluginsById = new Map(
    definitions.map((entry) => [entry.plugin.manifest.id, entry.plugin] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (pluginId: string): readonly string[] | undefined => {
    if (visiting.has(pluginId)) {
      const startIndex = stack.indexOf(pluginId);
      if (startIndex >= 0) {
        return [...stack.slice(startIndex), pluginId];
      }

      return [pluginId, pluginId];
    }

    if (visited.has(pluginId)) {
      return undefined;
    }

    visited.add(pluginId);
    visiting.add(pluginId);
    stack.push(pluginId);

    const plugin = pluginsById.get(pluginId);
    for (const dependencyId of getNormalizedDependencies(plugin?.manifest ?? { id: pluginId })) {
      if (!pluginsById.has(dependencyId)) {
        continue;
      }

      const cycle = visit(dependencyId);
      if (cycle !== undefined) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(pluginId);
    return undefined;
  };

  for (const entry of definitions) {
    const cycle = visit(entry.plugin.manifest.id);
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return [];
}

export function validatePluginDependencies(
  definitions: readonly PluginDefinition[],
): readonly PluginHostIssue[] {
  const knownIds = new Set(definitions.map((definition) => definition.manifest.id));
  const issues: PluginHostIssue[] = [];

  for (const definition of definitions) {
    const { id, dependencies = [] } = definition.manifest;
    for (const dependencyId of dependencies) {
      if (!knownIds.has(dependencyId)) {
        const issue: MissingPluginDependencyIssue = {
          code: "missing-plugin-dependency",
          pluginId: id,
          dependencyId,
          registeredIds: definitions.map((entry) => entry.manifest.id),
          message: `Plugin "${id}" depends on "${dependencyId}", but "${dependencyId}" has not been registered. Registered plugins: ${definitions
            .map((entry) => entry.manifest.id)
            .join(", ")}.`,
        };

        issues.push(issue);
      }
    }
  }

  return issues;
}

export function resolvePluginOrder(
  definitions: readonly PluginDefinition[],
): readonly PluginDefinition[] {
  const dependencyIssues = validatePluginDependencies(definitions);
  if (dependencyIssues.length > 0) {
    throw new PluginHostError(dependencyIssues);
  }

  const ordered: PluginDefinition[] = [];
  const resolvedIds = new Set<string>();
  const unresolved = definitions.map((plugin, index) => ({ plugin, index }));

  while (ordered.length < definitions.length) {
    let next: ResolvedPlugin | undefined;
    for (const candidate of unresolved) {
      if (resolvedIds.has(candidate.plugin.manifest.id)) {
        continue;
      }

      const dependencies = candidate.plugin.manifest.dependencies ?? [];
      if (dependencies.every((dependencyId) => resolvedIds.has(dependencyId))) {
        if (next === undefined || candidate.index < next.index) {
          next = candidate;
        }
      }
    }

    if (next === undefined) {
      const cycle = findCycle(
        unresolved.filter((entry) => !resolvedIds.has(entry.plugin.manifest.id)),
      );
      const issue: CyclicPluginDependencyIssue = {
        code: "cyclic-plugin-dependency",
        cycle,
        message:
          cycle.length > 0
            ? `Plugin dependency cycle detected: ${cycle.join(" -> ")}.`
            : "Plugin dependency cycle detected, but the cycle could not be reconstructed.",
      };

      throw new PluginHostError(issue);
    }

    resolvedIds.add(next.plugin.manifest.id);
    ordered.push(next.plugin);
  }

  return ordered;
}
