import type { AgentHarnessConfig } from "../harness/types.js";
export type { AgentHarnessConfig } from "../harness/types.js";

export const CONFIG_SCHEMA_VERSION = "v1" as const;

export const AGENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
export const PACKAGE_NAME_PATTERN = "^(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$";

export interface FrameworkRuntimeConfig {
  mode?: string;
  retries?: number;
  tracing?: boolean;
  workspaceRoot?: string;
  storage?: {
    provider?: string;
  };
  queue?: {
    provider?: string;
  };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
  };
}

export interface FrameworkConfig {
  schemaVersion?: typeof CONFIG_SCHEMA_VERSION;
  name?: string;
  id?: string;
  preset?: string;
  primaryAgent?: string;
  primaryHarness?: string;
  plugins?: string[];
  runtime?: FrameworkRuntimeConfig;
  metadata?: Record<string, unknown>;
}

export interface AgentMemoryConfig {
  provider?: string;
  path?: string;
  maxEntries?: number;
}

export interface AgentConfig {
  id: string;
  displayName?: string;
  model?: string;
  instructions?: string;
  preset?: string;
  plugins?: string[];
  tools?: string[];
  memory?: AgentMemoryConfig;
  metadata?: Record<string, unknown>;
}

export interface PluginConfig {
  plugin?: string;
  package?: string;
  enabled?: boolean;
  dependsOn?: string[];
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PresetPluginBinding {
  id: string;
  packageName?: string;
  required?: boolean;
  description?: string;
}

export interface PresetConfig {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
  plugins?: PresetPluginBinding[];
  frameworkDefaults?: Partial<FrameworkConfig>;
  agentDefaults?: Record<string, Partial<AgentConfig>>;
  pluginDefaults?: Record<string, Partial<PluginConfig>>;
  metadata?: Record<string, unknown>;
}

export interface ResolvedConfigSources {
  framework?: string;
  agents?: Record<string, string>;
  harnesses?: Record<string, string>;
  plugins?: Record<string, string>;
  order?: string[];
}

export interface ResolvedConfig {
  framework: FrameworkConfig;
  agents: Record<string, AgentConfig>;
  harnesses?: Record<string, AgentHarnessConfig>;
  plugins: Record<string, PluginConfig>;
  preset?: PresetConfig;
  sources?: ResolvedConfigSources;
  metadata?: Record<string, unknown>;
}
