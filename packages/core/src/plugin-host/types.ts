import type { Registry } from "../registries/index.js";

export interface PluginManifest {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly version?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export type PluginLifecyclePhase = "setup" | "start" | "stop";

export interface PluginLifecycleContext {
  readonly host: PluginHost;
  readonly registries: PluginHostRegistries;
  readonly state: Readonly<Record<string, unknown>>;
}

export type PluginLifecycleHook = (context: PluginLifecycleContext) => void | Promise<void>;

export interface PluginLifecycle {
  readonly setup?: PluginLifecycleHook;
  readonly start?: PluginLifecycleHook;
  readonly stop?: PluginLifecycleHook;
}

export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly lifecycle?: PluginLifecycle;
}

export interface PluginHostRegistries {
  readonly plugins: Registry<PluginDefinition>;
  readonly manifests: Registry<PluginManifest>;
}

export interface PluginHost {
  readonly registries: PluginHostRegistries;

  register(plugin: PluginDefinition): PluginDefinition;
  list(): readonly PluginDefinition[];
  resolveOrder(): readonly PluginDefinition[];
  validate(): readonly import("./errors.js").PluginHostIssue[];
  runLifecycle(phase: PluginLifecyclePhase, state?: Record<string, unknown>): Promise<void>;
}
