// A persistent Python workspace an agent drives through one `python` tool, borrowed from Prime
// Agent's RLM (recursive language model) working style: large inputs live in variables instead of
// the conversation, code slices and transforms them, `rlm.llm` sends pieces to smaller models,
// `rlm.tool` calls the agent's other tools, and only what the code prints comes back.

import type { AgentMessage, AgentTool, AgentToolResult } from "@generic-ai/agent";
import { type AssistantMessage, complete, type Model, type StreamOptions } from "@generic-ai/ai";
import { Type } from "@sinclair/typebox";

import {
  type KernelExecution,
  type KernelHostRequest,
  type KernelLaunch,
  PythonKernel,
} from "./kernel.js";

export interface RlmLlmOptions {
  /** The model `rlm.llm` uses when the code names none (usually a small, cheap one). */
  readonly model: Model;
  /** Resolve a model the code names (`"provider/id"` or an alias). */
  readonly resolveModel?: ((reference: string) => Model | undefined) | undefined;
  /** Models listed by `rlm.models()`. Defaults to the default model. */
  readonly models?: (() => readonly Model[]) | undefined;
  readonly getApiKey?: ((provider: string) => string | undefined) | undefined;
  /** Replaces `complete` from `@generic-ai/ai` (tests, metering, a proxy). */
  readonly complete?:
    | ((model: Model, prompt: RlmLlmPrompt, signal: AbortSignal) => Promise<AssistantMessage>)
    | undefined;
  /** Extra provider options for each call. */
  readonly streamOptions?: Omit<StreamOptions, "signal" | "apiKey"> | undefined;
  /** Default output limit per call. */
  readonly maxTokens?: number | undefined;
  /** Model calls in flight at once across the workspace. Defaults to 8. */
  readonly maxConcurrency?: number | undefined;
  /** Model calls one tool call may make. Defaults to 200. */
  readonly maxCallsPerExecution?: number | undefined;
  /** Called with each finished sub-model response, for usage metering. */
  readonly onResponse?:
    | ((message: AssistantMessage, model: Model) => Promise<void> | void)
    | undefined;
}

export interface RlmLlmPrompt {
  readonly prompt: string;
  readonly system?: string | undefined;
  readonly maxTokens?: number | undefined;
}

export interface RlmWorkspaceOptions {
  /** Working directory of the kernel. */
  readonly cwd: string;
  /** Python executable. Defaults to `GENERIC_AI_PYTHON` or `python3`. */
  readonly python?: string | undefined;
  /** Kernel environment. Defaults to the agent command allowlist. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Rewrite the kernel launch, for example to run it as the agent OS user. */
  readonly launch?: ((input: KernelLaunch) => KernelLaunch) | undefined;
  /** Sub-model calls from code (`rlm.llm`, `rlm.llm_batch`). Without it they fail. */
  readonly llm?: RlmLlmOptions | undefined;
  /** Tools the code may call with `rlm.tool`. The `python` tool itself is never offered. */
  readonly tools?: (() => readonly AgentTool[]) | undefined;
  /** The conversation, for `rlm.messages()`. */
  readonly getMessages?: (() => readonly AgentMessage[]) | undefined;
  /** JSON values put into the workspace as variables when it starts. */
  readonly variables?: Readonly<Record<string, unknown>> | undefined;
  /** Save the variables here when the workspace is disposed and load them when it starts. */
  readonly snapshotPath?: string | undefined;
  /** Default and maximum seconds per tool call. Defaults to 120 and 600. */
  readonly timeoutSeconds?: number | undefined;
  readonly maxTimeoutSeconds?: number | undefined;
  /** Characters of output returned to the model per call. Defaults to 20000. */
  readonly maxOutputChars?: number | undefined;
  /** Name of the tool. Defaults to `python`. */
  readonly toolName?: string | undefined;
}

export interface RlmExecutionDetails {
  readonly status: "ok" | "error";
  readonly timedOut?: boolean;
  readonly restarted?: boolean;
  readonly truncated: boolean;
  readonly outputChars: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
}

export type RlmTool = AgentTool<typeof pythonSchema, RlmExecutionDetails> & {
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
};

export interface RlmWorkspace {
  readonly kernel: PythonKernel;
  readonly tool: RlmTool;
  /** Put JSON values into the workspace as variables. */
  setVariables(values: Readonly<Record<string, unknown>>): Promise<void>;
  /** Snapshot the variables (when `snapshotPath` is set) and stop the kernel. */
  dispose(): Promise<void>;
}

const pythonSchema = Type.Object({
  code: Type.String({
    description:
      "Python to run in the persistent workspace. Top-level await works; the value of a trailing expression is shown.",
  }),
  timeout_seconds: Type.Optional(
    Type.Integer({ minimum: 1, description: "Seconds before the cell is interrupted." }),
  ),
});

const PROMPT_SNIPPET =
  "Run Python in a persistent workspace. Variables, imports and files persist between calls.";

const PROMPT_GUIDELINES = [
  "Use the python workspace for large inputs: load files or tool results into variables and print only the slices, counts or summaries you need, never whole documents.",
  "From python, `await rlm.llm(prompt, model=None)` asks a smaller model one question and returns its text; `await rlm.llm_batch(prompts)` asks many in parallel. Use them to map over chunks of a large input, then combine the answers in code.",
  "From python, `await rlm.tool(name, **args)` calls one of your other tools and keeps its result in the workspace (`.text`, `.details`, `.is_error`); `await rlm.tools()` and `await rlm.models()` list what is available, and `await rlm.messages()` returns this conversation as data.",
];

class Semaphore {
  #available: number;
  #waiters: (() => void)[] = [];

  constructor(size: number) {
    this.#available = Math.max(1, size);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#available > 0) this.#available -= 1;
    else await new Promise<void>((resolve) => this.#waiters.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiters.shift();
      if (next !== undefined) next();
      else this.#available += 1;
    }
  }
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string; thinking?: string; name?: string }) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "toolCall") return `[tool call: ${block.name ?? "?"}]`;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n");
}

function modelInfo(model: Model) {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reference: `${model.provider}/${model.id}`,
  };
}

/** Format a cell's output for the model, keeping the head and tail of long output. */
export function formatExecution(
  execution: KernelExecution,
  maxChars: number,
): { text: string; truncated: boolean; outputChars: number } {
  const streams = execution.output
    .filter((part) => part.kind !== "result")
    .map((part) => part.text)
    .join("");
  const results = execution.output
    .filter((part) => part.kind === "result")
    .map((part) => part.text);
  const sections: string[] = [];
  if (streams.length > 0) sections.push(streams.replace(/\n+$/, ""));
  for (const result of results) sections.push(`Out: ${result}`);
  if (execution.error !== undefined) {
    const traceback = execution.error.traceback.join("").trim();
    sections.push(
      traceback.length > 0 ? traceback : `${execution.error.ename}: ${execution.error.evalue}`,
    );
  }
  if (execution.timedOut === true)
    sections.push("[The cell ran past its timeout and was interrupted.]");
  if (execution.restarted === true) {
    sections.push("[The kernel was restarted: every variable and import is gone.]");
  }
  let text = sections.join("\n");
  if (text.length === 0)
    text = execution.status === "ok" ? "[no output]" : "[failed with no output]";
  const outputChars = text.length;
  if (text.length <= maxChars) return { text, truncated: false, outputChars };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  text = `${text.slice(0, head)}\n\n[... ${outputChars - maxChars} characters cut. Keep large values in variables and print slices or summaries instead ...]\n\n${text.slice(-tail)}`;
  return { text, truncated: true, outputChars };
}

/** Create a workspace and the `python` tool that drives it. The kernel starts on first use. */
export function createRlmWorkspace(options: RlmWorkspaceOptions): RlmWorkspace {
  const toolName = options.toolName ?? "python";
  const maxOutputChars = options.maxOutputChars ?? 20_000;
  const defaultTimeout = options.timeoutSeconds ?? 120;
  const maxTimeout = Math.max(defaultTimeout, options.maxTimeoutSeconds ?? 600);
  const llm = options.llm;
  const llmLimit = new Semaphore(llm?.maxConcurrency ?? 8);
  const maxLlmCalls = llm?.maxCallsPerExecution ?? 200;
  let counters = { llmCalls: 0, toolCalls: 0 };
  let executionSignal: AbortSignal | undefined;

  const callModel = async (request: KernelHostRequest, signal: AbortSignal) => {
    if (llm === undefined) throw new Error("rlm.llm is not available in this workspace");
    counters.llmCalls += 1;
    if (counters.llmCalls > maxLlmCalls) {
      throw new Error(`rlm.llm: more than ${maxLlmCalls} model calls in one python call`);
    }
    const reference = typeof request["model"] === "string" ? request["model"] : undefined;
    const model = reference === undefined ? llm.model : llm.resolveModel?.(reference);
    if (model === undefined) throw new Error(`rlm.llm: unknown model "${reference}"`);
    const prompt: RlmLlmPrompt = {
      prompt: String(request["prompt"] ?? ""),
      ...(typeof request["system"] === "string" ? { system: request["system"] } : {}),
      ...(typeof request["maxTokens"] === "number"
        ? { maxTokens: request["maxTokens"] }
        : llm.maxTokens === undefined
          ? {}
          : { maxTokens: llm.maxTokens }),
    };
    const combined =
      executionSignal === undefined ? signal : AbortSignal.any([signal, executionSignal]);
    const message = await llmLimit.run(async () => {
      if (llm.complete !== undefined) return llm.complete(model, prompt, combined);
      const apiKey = llm.getApiKey?.(model.provider);
      return complete(
        model,
        {
          ...(prompt.system === undefined ? {} : { systemPrompt: prompt.system }),
          messages: [{ role: "user", content: prompt.prompt, timestamp: Date.now() }],
        },
        {
          ...llm.streamOptions,
          signal: combined,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(prompt.maxTokens === undefined ? {} : { maxTokens: prompt.maxTokens }),
        },
      );
    });
    await llm.onResponse?.(message, model);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(`rlm.llm: ${message.errorMessage ?? message.stopReason}`);
    }
    return { text: assistantText(message), stopReason: message.stopReason };
  };

  const callableTools = () => (options.tools?.() ?? []).filter((tool) => tool.name !== toolName);

  const callTool = async (request: KernelHostRequest, signal: AbortSignal) => {
    const name = String(request["name"] ?? "");
    const tool = callableTools().find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`rlm.tool: no tool named "${name}"`);
    counters.toolCalls += 1;
    const args = (request["arguments"] ?? {}) as Record<string, unknown>;
    const prepared = tool.prepareArguments === undefined ? args : tool.prepareArguments(args);
    const combined =
      executionSignal === undefined ? signal : AbortSignal.any([signal, executionSignal]);
    try {
      const result = await tool.execute(
        `rlm-${Date.now()}-${counters.toolCalls}`,
        prepared,
        combined,
      );
      return {
        text: toolResultText(result),
        details: result.details ?? null,
        isError: result.isError === true,
      };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        details: null,
        isError: true,
      };
    }
  };

  const readMessages = (request: KernelHostRequest) => {
    const all = options.getMessages?.() ?? [];
    const role = typeof request["role"] === "string" ? request["role"] : "*";
    const rows = all
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => role === "*" || message.role === role);
    const start = typeof request["start"] === "number" ? request["start"] : -10;
    const limit = typeof request["limit"] === "number" ? request["limit"] : 10;
    const picked = rows
      .slice(start < 0 ? Math.max(rows.length + start, 0) : start)
      .slice(0, Math.max(limit, 0));
    return {
      total: rows.length,
      messages: picked.map(({ message, index }) => ({
        index,
        role: message.role,
        text: messageText(message),
      })),
    };
  };

  const onHostRequest = async (request: KernelHostRequest, signal: AbortSignal) => {
    switch (request.type) {
      case "llm":
        return callModel(request, signal);
      case "models": {
        const models = llm === undefined ? [] : (llm.models?.() ?? [llm.model]);
        return { models: models.map(modelInfo) };
      }
      case "tool":
        return callTool(request, signal);
      case "tools":
        return {
          tools: callableTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
        };
      case "messages":
        return readMessages(request);
      default:
        throw new Error(`Unknown host request "${request.type}"`);
    }
  };

  const kernel = new PythonKernel({
    cwd: options.cwd,
    ...(options.python === undefined ? {} : { python: options.python }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    onHostRequest,
  });

  let prepared: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    if (kernel.running && prepared !== undefined) return prepared;
    prepared = (async () => {
      await kernel.start();
      if (options.snapshotPath !== undefined) await kernel.restore(options.snapshotPath);
      if (options.variables !== undefined) await kernel.setVariables(options.variables);
    })();
    prepared.catch(() => {
      prepared = undefined;
    });
    return prepared;
  };

  // One cell at a time: parallel tool calls would otherwise interleave in one namespace.
  let queue: Promise<unknown> = Promise.resolve();

  const tool: RlmTool = {
    name: toolName,
    label: "Python",
    description: [
      "Run Python in a persistent workspace (one interpreter for the whole session). Variables, imports and background tasks survive between calls; top-level `await` works; the value of a trailing expression is shown.",
      "Keep large data in variables and print only what you need: output beyond the limit is cut.",
      "Inside the workspace, `rlm` gives you: `await rlm.llm(prompt, model=None, system=None, max_tokens=None)` (one sub-model call, returns text), `await rlm.llm_batch(prompts, ...)` (parallel calls), `await rlm.models()`, `await rlm.tool(name, **args)` (call another of your tools; returns `.text`, `.details`, `.is_error`), `await rlm.tools()`, and `await rlm.messages(start=-10, limit=10, role='*')` (this conversation as data).",
    ].join("\n"),
    parameters: pythonSchema,
    executionMode: "sequential",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    execute: (_toolCallId, params: { code: string; timeout_seconds?: number }, signal) => {
      const run = async (): Promise<AgentToolResult<RlmExecutionDetails>> => {
        await prepare();
        counters = { llmCalls: 0, toolCalls: 0 };
        executionSignal = signal;
        const timeoutSeconds = Math.min(params.timeout_seconds ?? defaultTimeout, maxTimeout);
        try {
          const execution = await kernel.execute(params.code, {
            timeoutMs: timeoutSeconds * 1000,
            ...(signal === undefined ? {} : { signal }),
          });
          if (execution.restarted === true) prepared = undefined;
          const formatted = formatExecution(execution, maxOutputChars);
          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              status: execution.status,
              ...(execution.timedOut === true ? { timedOut: true } : {}),
              ...(execution.restarted === true ? { restarted: true } : {}),
              truncated: formatted.truncated,
              outputChars: formatted.outputChars,
              llmCalls: counters.llmCalls,
              toolCalls: counters.toolCalls,
            },
            ...(execution.status === "error" ? { isError: true } : {}),
          };
        } finally {
          executionSignal = undefined;
        }
      };
      const next = queue.then(run, run);
      queue = next.catch(() => {});
      return next;
    },
  };

  return {
    kernel,
    tool,
    async setVariables(values) {
      await prepare();
      await kernel.setVariables(values);
    },
    async dispose() {
      await queue;
      if (options.snapshotPath !== undefined && kernel.running) {
        try {
          await kernel.snapshot(options.snapshotPath);
        } catch {
          // A failed snapshot must not keep the session from ending.
        }
      }
      await kernel.dispose();
    },
  };
}
