export const name = "@generic-ai/sdk";

export * as config from "./config/index.js";
export * from "./contracts/index.js";
export * from "./evals/index.js";
export * from "./events/index.js";
export * from "./goals/index.js";
export * from "./harness/index.js";
export * from "./preset.js";
export * from "./run-envelope/index.js";
export * from "./scope/index.js";
export * from "./tools/index.js";
export * from "./usage/index.js";

// Re-export key config types for convenience
export type {
  ResolvedConfig,
  FrameworkConfig,
  AgentConfig,
  AgentHarnessConfig,
  PluginConfig,
  PresetConfig,
} from "./config/types.js";

export * as contracts from "./contracts/index.js";
export * as evals from "./evals/index.js";
export * as goals from "./goals/index.js";
export * as helpers from "./helpers/index.js";
export * as harness from "./harness/index.js";
export * as scope from "./scope/index.js";

export {
  attachRunEventLog,
  createQueueWorker,
  NonRetryableJobError,
  replayRunEvents,
} from "./helpers/index.js";
export type {
  AttachRunEventLogOptions,
  QueueWorker,
  QueueWorkerEvent,
  QueueWorkerHandler,
  QueueWorkerJobContext,
  QueueWorkerOptions,
  ReplayRunEventsOptions,
} from "./helpers/index.js";
export * as usage from "./usage/index.js";
