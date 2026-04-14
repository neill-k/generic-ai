export type PluginHostIssueCode =
  | "invalid-plugin-manifest"
  | "duplicate-plugin-id"
  | "missing-plugin-dependency"
  | "cyclic-plugin-dependency";

export interface InvalidPluginManifestIssue {
  readonly code: "invalid-plugin-manifest";
  readonly message: string;
  readonly field: "manifest" | "id" | "dependencies";
  readonly pluginId?: string;
}

export interface DuplicatePluginIdIssue {
  readonly code: "duplicate-plugin-id";
  readonly message: string;
  readonly pluginId: string;
}

export interface MissingPluginDependencyIssue {
  readonly code: "missing-plugin-dependency";
  readonly message: string;
  readonly pluginId: string;
  readonly dependencyId: string;
  readonly registeredIds: readonly string[];
}

export interface CyclicPluginDependencyIssue {
  readonly code: "cyclic-plugin-dependency";
  readonly message: string;
  readonly cycle: readonly string[];
}

export type PluginHostIssue =
  | InvalidPluginManifestIssue
  | DuplicatePluginIdIssue
  | MissingPluginDependencyIssue
  | CyclicPluginDependencyIssue;

export class PluginHostError extends Error {
  override readonly name = "PluginHostError";
  readonly code: PluginHostIssueCode;
  readonly issues: readonly PluginHostIssue[];

  constructor(issues: PluginHostIssue | readonly PluginHostIssue[]) {
    const normalizedIssues = Array.isArray(issues) ? issues : [issues];
    super(normalizedIssues[0]?.message ?? "Plugin host validation failed.");
    this.code = normalizedIssues[0]?.code ?? "invalid-plugin-manifest";
    this.issues = normalizedIssues;
  }
}
