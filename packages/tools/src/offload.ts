/**
 * Offloading (NOVA's second principle: move work out of the model). A tool result longer than a
 * threshold is written to an output file, and the model gets a short preview, the size, and the
 * path to read the rest from. `tool_batch` lets the agent run several independent tool calls in one
 * step, each result offloaded the same way, instead of spending a model turn per call.
 */

import type { AgentTool, AgentToolResult } from "@generic-ai/agent";
import { type JsonObject, validateToolArguments } from "@generic-ai/ai";
import { Type } from "@sinclair/typebox";

import { writeOutputFile } from "./output-files.js";

export const TOOL_BATCH_TOOL = "tool_batch";

export interface OffloadOptions {
  /** Results whose text is longer than this many characters are offloaded. Default 16000. */
  readonly maxChars?: number;
  /** Characters kept from the start of an offloaded result. Default 1500. */
  readonly headChars?: number;
  /** Characters kept from the end of an offloaded result. Default 500. */
  readonly tailChars?: number;
  /** Tools whose results are never offloaded. */
  readonly exclude?: readonly string[];
  /** Writes the full text and returns its path. Defaults to an output file in the temp directory. */
  readonly write?: (toolName: string, text: string) => Promise<string>;
  /** Called after each offload. */
  readonly onOffload?: (event: OffloadEvent) => void;
}

export interface OffloadEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly path: string;
  readonly totalChars: number;
  readonly shownChars: number;
}

export interface OffloadedDetails {
  readonly offloaded: {
    readonly path: string;
    readonly totalChars: number;
  };
}

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_HEAD_CHARS = 1500;
const DEFAULT_TAIL_CHARS = 500;

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function existingFullOutput(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function defaultWrite(toolName: string, text: string): Promise<string> {
  const slug = toolName.toLowerCase().replace(/[^a-z]/g, "") || "result";
  // `generic-ai-<letters>-<16 hex>.txt` is the name the workspace read tool accepts outside the workspace.
  return writeOutputFile(`generic-ai-${slug}`, ".txt", text);
}

/**
 * Offloads one result when its text is too long. Images and short results pass through unchanged,
 * and so does a result when the file cannot be written.
 */
export async function offloadToolResult<T>(
  toolName: string,
  toolCallId: string,
  result: AgentToolResult<T>,
  options: OffloadOptions = {},
): Promise<AgentToolResult<T>> {
  if (options.exclude?.includes(toolName) === true) {
    return result;
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const text = resultText(result);
  if (text.length <= maxChars) {
    return result;
  }
  const headChars = options.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
  let path: string;
  try {
    path = await (options.write ?? defaultWrite)(toolName, text);
  } catch {
    return result;
  }
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - head.length - tail.length;
  const preview = [
    head,
    `\n\n[... ${omitted} characters omitted ...]\n\n`,
    tail,
    `\n\n[Result offloaded: ${text.length} characters saved to ${path}. Read it with the read tool (offset and limit) or search it, rather than asking for the whole result again.]`,
  ].join("");
  const fullOutput = existingFullOutput(result.details);
  options.onOffload?.({
    toolName,
    toolCallId,
    path,
    totalChars: text.length,
    shownChars: head.length + tail.length,
  });
  return {
    ...result,
    content: [
      { type: "text", text: preview },
      ...result.content.filter((block) => block.type !== "text"),
    ],
    details: {
      ...(typeof result.details === "object" && result.details !== null ? result.details : {}),
      offloaded: {
        path,
        totalChars: text.length,
        ...(fullOutput === undefined ? {} : { fullOutput }),
      },
    } as T,
  };
}

/** Wraps a tool so its long results are offloaded. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools
export function withOffload<T extends AgentTool<any, any>>(
  tool: T,
  options: OffloadOptions = {},
): T {
  if (options.exclude?.includes(tool.name) === true) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) =>
      offloadToolResult(
        tool.name,
        toolCallId,
        await tool.execute(toolCallId, params, signal, onUpdate),
        options,
      ),
  };
}

export interface ToolBatchOptions {
  /** At most this many calls per batch. Default 10. */
  readonly maxCalls?: number;
  /** Tools the batch may not call (it never calls itself). */
  readonly exclude?: readonly string[];
}

interface BatchCall {
  readonly tool: string;
  readonly arguments?: Record<string, unknown>;
}

export interface ToolBatchCallResult {
  readonly tool: string;
  readonly isError: boolean;
  readonly text: string;
}

/**
 * `tool_batch` runs several independent tool calls in one step. Calls run concurrently, except tools
 * marked sequential, which run one at a time after the others. Each call goes through the tool's own
 * `execute`, so the policy and lifecycle hooks wrapped around it still apply. Pass the session's
 * offloaded tools, so long results come back as previews.
 */
export function createToolBatchTool(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools
  getTools: () => readonly AgentTool<any, any>[],
  options: ToolBatchOptions = {},
): AgentTool {
  const maxCalls = options.maxCalls ?? 10;
  const excluded = new Set([TOOL_BATCH_TOOL, ...(options.exclude ?? [])]);
  return {
    name: TOOL_BATCH_TOOL,
    label: "Tool batch",
    description: `Run up to ${maxCalls} independent tool calls in one step and get all their results together. Use it when you already know several calls you need (reading several files, several searches) and none depends on another's result. Long results come back as previews with a file path.`,
    parameters: Type.Object({
      calls: Type.Array(
        Type.Object({
          tool: Type.String({ description: "The tool name." }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments." }),
          ),
        }),
        { minItems: 1, description: "The calls to run." },
      ),
    }),
    execute: async (toolCallId, params: { calls: BatchCall[] }, signal) => {
      if (params.calls.length > maxCalls) {
        throw new Error(`tool_batch takes at most ${maxCalls} calls; split the batch`);
      }
      const tools = new Map(getTools().map((tool) => [tool.name, tool]));
      const run = async (call: BatchCall, index: number): Promise<ToolBatchCallResult> => {
        const tool = excluded.has(call.tool) ? undefined : tools.get(call.tool);
        if (tool === undefined) {
          return {
            tool: call.tool,
            isError: true,
            text: `Unknown or unavailable tool: ${call.tool}`,
          };
        }
        try {
          const id = `${toolCallId}:${index}`;
          const args = validateToolArguments(tool, {
            type: "toolCall",
            id,
            name: tool.name,
            arguments: (tool.prepareArguments?.(call.arguments ?? {}) ??
              call.arguments ??
              {}) as JsonObject,
          });
          const result = await tool.execute(id, args, signal);
          return { tool: call.tool, isError: result.isError === true, text: resultText(result) };
        } catch (error) {
          return {
            tool: call.tool,
            isError: true,
            text: error instanceof Error ? error.message : String(error),
          };
        }
      };
      const results: ToolBatchCallResult[] = new Array(params.calls.length);
      const sequential: number[] = [];
      await Promise.all(
        params.calls.map(async (call, index) => {
          if (tools.get(call.tool)?.executionMode === "sequential") {
            sequential.push(index);
            return;
          }
          results[index] = await run(call, index);
        }),
      );
      for (const index of sequential.sort((left, right) => left - right)) {
        results[index] = await run(params.calls[index] as BatchCall, index);
      }
      const text = results
        .map(
          (result, index) =>
            `## ${index + 1}. ${result.tool}${result.isError ? " (error)" : ""}\n${result.text}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  };
}
