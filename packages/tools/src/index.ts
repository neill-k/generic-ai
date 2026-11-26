import type { AgentTool } from "@generic-ai/agent";
import { type BashToolOptions, createBashTool } from "./bash.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createFindTool, type FindToolOptions } from "./find.js";
import { createGrepTool, type GrepToolOptions } from "./grep.js";
import { createLsTool, type LsToolOptions } from "./ls.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";

export {
  type BashOperations,
  type BashSpawnContext,
  type BashSpawnHook,
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
  createBashTool,
  createBashToolDefinition,
  createLocalBashOperations,
} from "./bash.js";
export {
  createEditTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
  createFindTool,
  createFindToolDefinition,
  type FindOperations,
  type FindToolDetails,
  type FindToolInput,
  type FindToolOptions,
} from "./find.js";
export {
  createGrepTool,
  createGrepToolDefinition,
  type GrepOperations,
  type GrepToolDetails,
  type GrepToolInput,
  type GrepToolOptions,
} from "./grep.js";
export {
  createLsTool,
  createLsToolDefinition,
  type LsOperations,
  type LsToolDetails,
  type LsToolInput,
  type LsToolOptions,
} from "./ls.js";
export {
  createReadTool,
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
} from "./read.js";
export {
  type ToolContextFactory,
  type TypeBoxAgentTool,
  wrapToolDefinition,
} from "./tool-definition-wrapper.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  sliceHead,
  sliceTail,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
  truncateLine,
  truncateTail,
} from "./truncate.js";
export type { ToolContext, ToolDefinition } from "./types.js";
export {
  createWriteTool,
  createWriteToolDefinition,
  type WriteOperations,
  type WriteToolInput,
  type WriteToolOptions,
} from "./write.js";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  write?: WriteToolOptions;
  edit?: EditToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
type Tool = AgentTool<any, any>;

/** The full coding tool set: read, bash, edit, write, grep, find, ls. */
export function createCodingTools(cwd: string, options: ToolsOptions = {}): Tool[] {
  return [
    createReadTool(cwd, options.read),
    createBashTool(cwd, options.bash),
    createEditTool(cwd, options.edit),
    createWriteTool(cwd, options.write),
    createGrepTool(cwd, options.grep),
    createFindTool(cwd, options.find),
    createLsTool(cwd, options.ls),
  ] as Tool[];
}

/** Tools that never change the workspace: read, grep, find, ls. */
export function createReadOnlyTools(cwd: string, options: ToolsOptions = {}): Tool[] {
  return [
    createReadTool(cwd, options.read),
    createGrepTool(cwd, options.grep),
    createFindTool(cwd, options.find),
    createLsTool(cwd, options.ls),
  ] as Tool[];
}
export { normalizePath, pathsEqual, resolvePath } from "./paths.js";
