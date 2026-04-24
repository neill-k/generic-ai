export {
  createBashTool,
  createBashToolDefinition,
  createCodingTools,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createReadOnlyTools,
  createWriteTool,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

import {
  createBashTool,
  createBashToolDefinition,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

const defaultToolCwd = process.cwd();

export const readTool = createReadTool(defaultToolCwd);
export const writeTool = createWriteTool(defaultToolCwd);
export const editTool = createEditTool(defaultToolCwd);
export const bashTool = createBashTool(defaultToolCwd);
export const grepTool = createGrepTool(defaultToolCwd);
export const findTool = createFindTool(defaultToolCwd);
export const lsTool = createLsTool(defaultToolCwd);
export const bashToolDefinition = createBashToolDefinition(defaultToolCwd);
export const codingTools: ReturnType<typeof createCodingTools> =
  createCodingTools(defaultToolCwd);
export const readOnlyTools: ReturnType<typeof createReadOnlyTools> =
  createReadOnlyTools(defaultToolCwd);

export type {
  BashOperations,
  BashSpawnContext,
  BashSpawnHook,
  BashToolDetails,
  BashToolInput,
  BashToolOptions,
  EditOperations,
  EditToolDetails,
  EditToolInput,
  EditToolOptions,
  FindOperations,
  FindToolDetails,
  FindToolInput,
  FindToolOptions,
  GrepOperations,
  GrepToolDetails,
  GrepToolInput,
  GrepToolOptions,
  LsOperations,
  LsToolDetails,
  LsToolInput,
  LsToolOptions,
  ReadOperations,
  ReadToolDetails,
  ReadToolInput,
  ReadToolOptions,
  ToolsOptions,
  TruncationOptions,
  TruncationResult,
  WriteOperations,
  WriteToolInput,
  WriteToolOptions,
} from "@mariozechner/pi-coding-agent";
