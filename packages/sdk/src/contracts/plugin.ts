import type { Awaitable, JsonObject } from "./shared.js";
import type { ConfigSchemaContract } from "./config-schema.js";
import type { LifecycleHooks } from "./lifecycle.js";
import type { RegistryContract } from "./registry.js";
import type { QueueContract } from "./queue.js";
import type { Scope } from "../scope/index.js";
import type { StorageContract } from "./storage.js";
import type { WorkspaceContract } from "./workspace.js";

export interface PluginDependency {
  readonly id: string;
  readonly versionRange?: string;
  readonly optional?: boolean;
}

export interface PluginManifest {
  readonly kind: "plugin";
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly dependencies?: readonly PluginDependency[];
  readonly tags?: readonly string[];
}

export interface PluginRuntimeContext<TConfig = unknown> {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly scope: Scope;
  readonly config: TConfig;
  readonly registries: Readonly<Record<string, RegistryContract<unknown>>>;
  readonly storage?: StorageContract;
  readonly workspace?: WorkspaceContract;
  readonly queue?: QueueContract;
  readonly runtime?: JsonObject;
}

export interface PluginContract<TConfig = unknown> {
  readonly manifest: PluginManifest;
  readonly configSchema?: ConfigSchemaContract<TConfig>;
  readonly lifecycle?: LifecycleHooks<PluginRuntimeContext<TConfig>>;
  register?(context: PluginRuntimeContext<TConfig>): Awaitable<void>;
}

