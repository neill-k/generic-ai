export type {
  AgentTaskExecutionInput,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
  DelegationErrorSnapshot,
  DelegationExecutor,
  DelegationExecutorContext,
  DelegationRequest,
  DelegationResult,
  DelegationTerminalStatus,
} from "@generic-ai/sdk";

export * from "./agents.js";
export * from "./cascade.js";
export * from "./executor.js";
export * from "./run-persistence.js";
export * from "./tasks.js";

export const name = "@generic-ai/plugin-delegation" as const;
export const kind = "delegation" as const;
export * from "./goals.js";
