export const name = "@generic-ai/sdk";

export * as config from "./config/index.js";
export * from "./contracts/index.js";
export * from "./events/index.js";
export * from "./pi/index.js";
export * from "./preset.js";
export * from "./run-envelope/index.js";
export * from "./scope/index.js";

// Re-export key config types for convenience
export type {
  ResolvedConfig,
  FrameworkConfig,
  AgentConfig,
  PluginConfig,
  PresetConfig,
} from "./config/types.js";

export * as contracts from "./contracts/index.js";
export * as helpers from "./helpers/index.js";
export * as pi from "./pi/index.js";
export * as scope from "./scope/index.js";
