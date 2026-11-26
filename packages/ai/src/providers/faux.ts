// Behaviour adapted from pi's faux provider (https://github.com/badlogic/pi-mono),
// MIT License, Copyright (c) 2026 Earendil Inc. See THIRD_PARTY_NOTICES.md in this package.
import { AssistantMessageEventStream } from "../event-stream.js";
import { parseStreamingJson } from "../json-parse.js";
import { registerApi, unregisterApi } from "../registry.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "../types.js";
import { emptyUsage } from "../usage.js";

/**
 * Scripted in-process provider for tests and offline development. Register it, queue assistant
 * messages (or factories), and every request streams the next one with realistic block events,
 * estimated usage, simulated prompt caching, optional pacing, and abort handling. No network, no
 * keys, no cost.
 */

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

export interface FauxModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export interface FauxProviderState {
  callCount: number;
}

export type FauxResponseFactory = (
  context: Context,
  options: StreamOptions | undefined,
  state: FauxProviderState,
  model: Model,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface RegisterFauxProviderOptions {
  api?: string;
  provider?: string;
  models?: FauxModelDefinition[];
  /** Pace streaming at this many estimated tokens per second. Unset streams as fast as microtasks allow. */
  tokensPerSecond?: number;
  /** Size of each streamed delta, in estimated tokens (4 characters each). Default 3 to 5. */
  tokenSize?: { min?: number; max?: number };
}

export interface FauxProviderRegistration {
  api: string;
  provider: string;
  models: [Model, ...Model[]];
  getModel(): Model;
  getModel(modelId: string): Model | undefined;
  state: FauxProviderState;
  setResponses(responses: FauxResponseStep[]): void;
  appendResponses(responses: FauxResponseStep[]): void;
  getPendingResponseCount(): number;
  unregister(): void;
}

let idCounter = 0;

function randomId(prefix: string): string {
  idCounter += 1;
  return `${prefix}:${Date.now()}:${idCounter}:${Math.random().toString(36).slice(2)}`;
}

export function fauxText(text: string): TextContent {
  return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
  return { type: "thinking", thinking };
}

export function fauxToolCall(
  name: string,
  args: ToolCall["arguments"],
  options: { id?: string } = {},
): ToolCall {
  return { type: "toolCall", id: options.id ?? randomId("tool"), name, arguments: args };
}

/** Build an assistant message for a faux response. `stopReason` defaults to "stop". */
export function fauxAssistantMessage(
  content: string | FauxContentBlock | FauxContentBlock[],
  options: {
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    responseId?: string;
    timestamp?: number;
  } = {},
): AssistantMessage {
  const blocks =
    typeof content === "string"
      ? [fauxText(content)]
      : Array.isArray(content)
        ? content
        : [content];
  return {
    role: "assistant",
    content: blocks,
    api: DEFAULT_API,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL_ID,
    usage: emptyUsage(),
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    ...(options.responseId === undefined ? {} : { responseId: options.responseId }),
    timestamp: options.timestamp ?? Date.now(),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`,
    )
    .join("\n");
}

function assistantContentToText(content: AssistantMessage["content"]): string {
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "thinking") {
        return block.thinking;
      }
      return `${block.name}:${JSON.stringify(block.arguments)}`;
    })
    .join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
  return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
  if (message.role === "user") {
    return contentToText(message.content);
  }
  if (message.role === "assistant") {
    return assistantContentToText(message.content);
  }
  return toolResultToText(message);
}

/** One text per prompt segment: the system prompt, each message, then the tool list. */
function promptSegments(context: Context): string[] {
  const segments: string[] = [];
  if (context.systemPrompt) {
    segments.push(`system:${context.systemPrompt}`);
  }
  for (const message of context.messages) {
    segments.push(`${message.role}:${messageToText(message)}`);
  }
  if (context.tools && context.tools.length > 0) {
    segments.push(`tools:${JSON.stringify(context.tools)}`);
  }
  return segments;
}

/** Length of the prompt that joins the first `count` segments with blank lines. */
function joinedLength(segments: readonly string[], count = segments.length): number {
  let length = count > 0 ? (count - 1) * 2 : 0;
  for (let index = 0; index < count; index += 1) {
    length += segments[index]?.length ?? 0;
  }
  return length;
}

function commonPrefixLength(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

/** Common prefix of two joined prompts: equal segments compare whole, then characters from the first difference. */
function commonPromptPrefixLength(previous: readonly string[], current: readonly string[]): number {
  let index = 0;
  while (index < previous.length && index < current.length && previous[index] === current[index]) {
    index += 1;
  }
  const rest = (segments: readonly string[]) =>
    index === segments.length ? "" : (index > 0 ? "\n\n" : "") + segments.slice(index).join("\n\n");
  return joinedLength(previous, index) + commonPrefixLength(rest(previous), rest(current));
}

function estimateUsage(
  message: AssistantMessage,
  context: Context,
  options: StreamOptions | undefined,
  promptCache: Map<string, readonly string[]>,
): Usage {
  const prompt = promptSegments(context);
  const promptTokens = Math.ceil(joinedLength(prompt) / 4);
  const output = estimateTokens(assistantContentToText(message.content));
  let input = promptTokens;
  let cacheRead = 0;
  let cacheWrite = 0;
  const sessionId = options?.sessionId;
  if (sessionId && options?.cacheRetention !== "none") {
    const previous = promptCache.get(sessionId);
    if (previous) {
      cacheRead = Math.ceil(commonPromptPrefixLength(previous, prompt) / 4);
      cacheWrite = Math.max(0, promptTokens - cacheRead);
    } else {
      cacheWrite = promptTokens;
    }
    // Every prompt token is either read from or written to the simulated cache.
    input = 0;
    promptCache.set(sessionId, prompt);
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function splitByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
    const charSize = Math.max(1, tokenSize * 4);
    chunks.push(text.slice(index, index + charSize));
    index += charSize;
  }
  return chunks.length > 0 ? chunks : [""];
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
  if (!tokensPerSecond || tokensPerSecond <= 0) {
    return new Promise((resolve) => queueMicrotask(resolve));
  }
  const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function errorMessage(model: Model, error: unknown, usage: Usage = emptyUsage()): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function abortedMessage(partial: AssistantMessage): AssistantMessage {
  return {
    ...partial,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

async function streamWithDeltas(
  events: AssistantMessageEventStream,
  message: AssistantMessage,
  minTokenSize: number,
  maxTokenSize: number,
  tokensPerSecond: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
  const abort = () => {
    const aborted = abortedMessage(partial);
    events.push({ type: "error", reason: "aborted", error: aborted });
    events.end(aborted);
  };
  if (signal?.aborted) {
    abort();
    return;
  }
  events.push({ type: "start", partial: { ...partial } });

  for (let index = 0; index < message.content.length; index += 1) {
    if (signal?.aborted) {
      abort();
      return;
    }
    const block = message.content[index];
    if (!block) {
      continue;
    }

    if (block.type === "thinking") {
      const target: ThinkingContent = {
        type: "thinking",
        thinking: "",
        ...(block.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: block.thinkingSignature }),
      };
      partial.content = [...partial.content, target];
      events.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
      for (const chunk of splitByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
        await scheduleChunk(chunk, tokensPerSecond);
        if (signal?.aborted) {
          abort();
          return;
        }
        target.thinking += chunk;
        events.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: chunk,
          partial: { ...partial },
        });
      }
      events.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: { ...partial },
      });
      continue;
    }

    if (block.type === "text") {
      const target: TextContent = { type: "text", text: "" };
      partial.content = [...partial.content, target];
      events.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
      for (const chunk of splitByTokenSize(block.text, minTokenSize, maxTokenSize)) {
        await scheduleChunk(chunk, tokensPerSecond);
        if (signal?.aborted) {
          abort();
          return;
        }
        target.text += chunk;
        events.push({
          type: "text_delta",
          contentIndex: index,
          delta: chunk,
          partial: { ...partial },
        });
      }
      events.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: { ...partial },
      });
      continue;
    }

    const target: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
    partial.content = [...partial.content, target];
    events.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
    // Partial arguments come from the same tolerant parser real providers use, so consumers see them grow.
    let json = "";
    for (const chunk of splitByTokenSize(
      JSON.stringify(block.arguments),
      minTokenSize,
      maxTokenSize,
    )) {
      await scheduleChunk(chunk, tokensPerSecond);
      if (signal?.aborted) {
        abort();
        return;
      }
      json += chunk;
      target.arguments = parseStreamingJson(json);
      events.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: chunk,
        partial: { ...partial },
      });
    }
    target.arguments = block.arguments;
    events.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: block,
      partial: { ...partial },
    });
  }

  if (message.stopReason === "pending") {
    throw new Error("Faux response ended without a stop reason");
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    events.push({ type: "error", reason: message.stopReason, error: message });
    events.end(message);
    return;
  }
  events.push({ type: "done", reason: message.stopReason, message });
  events.end(message);
}

/** Register a faux provider. Call `unregister()` when done (for example in `afterEach`). */
export function registerFauxProvider(
  options: RegisterFauxProviderOptions = {},
): FauxProviderRegistration {
  const api = options.api ?? randomId(DEFAULT_API);
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const minTokenSize = Math.max(
    1,
    Math.min(
      options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE,
      options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE,
    ),
  );
  const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
  const tokensPerSecond = options.tokensPerSecond;
  const definitions: FauxModelDefinition[] =
    options.models && options.models.length > 0
      ? options.models
      : [{ id: DEFAULT_MODEL_ID, name: "Faux Model" }];
  const models = definitions.map(
    (definition): Model => ({
      id: definition.id,
      name: definition.name ?? definition.id,
      api,
      provider,
      baseUrl: "http://localhost:0",
      reasoning: definition.reasoning ?? false,
      input: definition.input ?? ["text", "image"],
      cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: definition.contextWindow ?? 128_000,
      maxTokens: definition.maxTokens ?? 16_384,
    }),
  ) as [Model, ...Model[]];
  const state: FauxProviderState = { callCount: 0 };
  const promptCache = new Map<string, readonly string[]>();
  let queue: FauxResponseStep[] = [];

  const stream = (model: Model, context: Context, streamOptions?: StreamOptions) => {
    const events = new AssistantMessageEventStream();
    const step = queue.shift();
    state.callCount += 1;
    queueMicrotask(async () => {
      try {
        await streamOptions?.onResponse?.({ status: 200, headers: new Headers() }, model);
        if (!step) {
          const usage = estimateUsage(
            { ...fauxAssistantMessage([]), content: [] },
            context,
            streamOptions,
            promptCache,
          );
          const message = errorMessage(model, new Error("No more faux responses queued"), usage);
          events.push({ type: "error", reason: "error", error: message });
          events.end(message);
          return;
        }
        const resolved =
          typeof step === "function" ? await step(context, streamOptions, state, model) : step;
        const cloned = structuredClone(resolved);
        const message: AssistantMessage = {
          ...cloned,
          api,
          provider,
          model: model.id,
          timestamp: cloned.timestamp ?? Date.now(),
        };
        message.usage = estimateUsage(message, context, streamOptions, promptCache);
        await streamWithDeltas(
          events,
          message,
          minTokenSize,
          maxTokenSize,
          tokensPerSecond,
          streamOptions?.signal,
        );
      } catch (error) {
        const message = errorMessage(model, error);
        events.push({ type: "error", reason: "error", error: message });
        events.end(message);
      }
    });
    return events;
  };

  registerApi(api, stream);

  function getModel(): Model;
  function getModel(modelId: string): Model | undefined;
  function getModel(modelId?: string): Model | undefined {
    return modelId === undefined ? models[0] : models.find((model) => model.id === modelId);
  }

  return {
    api,
    provider,
    models,
    getModel,
    state,
    setResponses: (responses) => {
      queue = [...responses];
    },
    appendResponses: (responses) => {
      queue.push(...responses);
    },
    getPendingResponseCount: () => queue.length,
    unregister: () => unregisterApi(api, stream),
  };
}
