// Native Mistral Chat Completions provider. Ported from pi (badlogic/pi-mono,
// packages/ai/src/api/mistral-conversations.ts). Copyright (c) 2026 Earendil Inc. MIT License; see
// THIRD_PARTY_NOTICES.md.

import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, fetchWithRetry, mergeHeaders, runProviderStream } from "../http.js";
import { parseStreamingJson, parseToolCallArguments } from "../json-parse.js";
import { readSseEvents } from "../sse.js";
import { transformMessages } from "../transform-messages.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolChoice,
} from "../types.js";
import { calculateCost } from "../usage.js";
import { resolveApiKey } from "./env.js";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_ERROR_BODY_CHARS = 4000;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

type ContentChunk =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string }
  | { type: "thinking"; thinking: { type: "text"; text: string }[] };

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentChunk[];
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    index: number;
  }[];
  tool_call_id?: string;
  name?: string;
  prefix?: boolean;
}

interface StreamToolCall {
  id?: string;
  index?: number;
  function: { name?: string; arguments?: string | Record<string, unknown> };
}

interface StreamChunk {
  id?: string;
  model?: string;
  usage?: Record<string, unknown> & {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices: {
    finish_reason?: string | null;
    delta: {
      content?: string | { type: string; text?: string; thinking?: { text?: string }[] }[] | null;
      tool_calls?: StreamToolCall[] | null;
    };
  }[];
}

/** Short alphanumeric hash (FNV-1a, two lanes), enough to derive stable 9-character ids. */
function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

function deriveMistralToolCallId(id: string, attempt: number): string {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) {
    return normalized;
  }
  const seedBase = normalized || id;
  const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
  return shortHash(seed)
    .padEnd(MISTRAL_TOOL_CALL_ID_LENGTH, "0")
    .slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

/**
 * Mistral requires tool-call ids of exactly 9 alphanumeric characters. The normalizer maps each
 * foreign id to a stable, collision-free Mistral id for the length of one request.
 */
export function createMistralToolCallIdNormalizer(): (id: string) => string {
  const ids = new Map<string, string>();
  const owners = new Map<string, string>();
  return (id) => {
    const existing = ids.get(id);
    if (existing) {
      return existing;
    }
    for (let attempt = 0; ; attempt += 1) {
      const candidate = deriveMistralToolCallId(id, attempt);
      const owner = owners.get(candidate);
      if (!owner || owner === id) {
        ids.set(id, candidate);
        owners.set(candidate, id);
        return candidate;
      }
    }
  };
}

function sanitize(text: string): string {
  // Lone surrogates make the request body invalid UTF-8.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

/** Pick the provider effort for a level, falling to the nearest supported level. */
function mapThinkingLevel(
  map: NonNullable<Model["thinkingLevelMap"]>,
  level: ThinkingLevel,
): string {
  const direct = map[level];
  if (typeof direct === "string") {
    return direct;
  }
  const start = THINKING_LEVELS.indexOf(level);
  for (let index = start + 1; index < THINKING_LEVELS.length; index += 1) {
    const value = map[THINKING_LEVELS[index] as ThinkingLevel];
    if (typeof value === "string") {
      return value;
    }
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = map[THINKING_LEVELS[index] as ThinkingLevel];
    if (typeof value === "string") {
      return value;
    }
  }
  return "high";
}

/**
 * Reasoning controls for a request. Models with a `thinkingLevelMap` (Mistral Medium and Small 3.2+,
 * hosted GLM) take `reasoning_effort`, including the map's "off" value when no reasoning is asked
 * for; other reasoning models (Magistral) take `prompt_mode: "reasoning"`.
 */
export function mistralReasoningControls(
  model: Model,
  reasoning: ThinkingLevel | undefined,
): { reasoning_effort?: string; prompt_mode?: "reasoning" } {
  if (!model.reasoning) {
    return {};
  }
  const map = model.thinkingLevelMap;
  if (map) {
    if (reasoning) {
      return { reasoning_effort: mapThinkingLevel(map, reasoning) };
    }
    return typeof map.off === "string" ? { reasoning_effort: map.off } : {};
  }
  return reasoning ? { prompt_mode: "reasoning" } : {};
}

function toolResultText(
  text: string,
  hasImages: boolean,
  supportsImages: boolean,
  isError: boolean,
): string {
  const trimmed = text.trim();
  const errorPrefix = isError ? "[tool error] " : "";
  if (trimmed.length > 0) {
    const imageSuffix =
      hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
    return `${errorPrefix}${trimmed}${imageSuffix}`;
  }
  if (hasImages) {
    const body = supportsImages
      ? "(see attached image)"
      : "(image omitted: model does not support images)";
    return `${errorPrefix}${body}`;
  }
  return `${errorPrefix}(no tool output)`;
}

/** Convert a transcript to Mistral chat messages (the system prompt is added by the caller). */
export function convertMistralMessages(messages: readonly Message[], model: Model): WireMessage[] {
  const supportsImages = model.input.includes("image");
  const normalize = createMistralToolCallIdNormalizer();
  const result: WireMessage[] = [];
  for (const message of transformMessages(messages, model, (id) => normalize(id))) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        result.push({ role: "user", content: sanitize(message.content) });
        continue;
      }
      const hadImages = message.content.some((block) => block.type === "image");
      const content: ContentChunk[] = message.content
        .filter((block) => block.type === "text" || supportsImages)
        .map((block) =>
          block.type === "text"
            ? { type: "text", text: sanitize(block.text) }
            : { type: "image_url", image_url: `data:${block.mimeType};base64,${block.data}` },
        );
      if (content.length > 0) {
        result.push({ role: "user", content });
      } else if (hadImages) {
        result.push({ role: "user", content: "(image omitted: model does not support images)" });
      }
      continue;
    }
    if (message.role === "assistant") {
      const content: ContentChunk[] = [];
      const toolCalls: NonNullable<WireMessage["tool_calls"]> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            content.push({ type: "text", text: sanitize(block.text) });
          }
        } else if (block.type === "thinking") {
          if (block.thinking.trim().length > 0) {
            content.push({
              type: "thinking",
              thinking: [{ type: "text", text: sanitize(block.thinking) }],
            });
          }
        } else {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
            index: 0,
          });
        }
      }
      if (content.length === 0 && toolCalls.length === 0) {
        continue;
      }
      result.push({
        role: "assistant",
        prefix: false,
        ...(content.length > 0 ? { content } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => sanitize(block.text))
      .join("\n");
    const hasImages = message.content.some((block) => block.type === "image");
    const content: ContentChunk[] = [
      { type: "text", text: toolResultText(text, hasImages, supportsImages, message.isError) },
    ];
    if (supportsImages) {
      for (const block of message.content) {
        if (block.type === "image") {
          content.push({
            type: "image_url",
            image_url: `data:${block.mimeType};base64,${block.data}`,
          });
        }
      }
    }
    result.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content,
    });
  }
  return result;
}

function convertTools(tools: readonly Tool[]): unknown[] {
  // JSON round trip drops TypeBox symbol keys, which the API rejects. Strict tools stay off: Mistral
  // Large can go silent for minutes before a strict tool call.
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)) as unknown,
      strict: false,
    },
  }));
}

function mapToolChoice(choice: ToolChoice): unknown {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.name } };
}

/** Build the Mistral `/v1/chat/completions` request body. */
export function buildMistralPayload(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Record<string, unknown> {
  const messages: WireMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: sanitize(context.systemPrompt) });
  }
  messages.push(...convertMistralMessages(context.messages, model));
  const payload: Record<string, unknown> = { model: model.id, stream: true, messages };
  if (context.tools && context.tools.length > 0) {
    payload["tools"] = convertTools(context.tools);
  }
  if (options?.temperature !== undefined) {
    payload["temperature"] = options.temperature;
  }
  if (options?.maxTokens !== undefined) {
    payload["max_tokens"] = options.maxTokens;
  }
  if (options?.toolChoice !== undefined) {
    payload["tool_choice"] = mapToolChoice(options.toolChoice);
  }
  Object.assign(payload, mistralReasoningControls(model, options?.reasoning));
  if (usesPromptCache(options)) {
    payload["prompt_cache_key"] = options.sessionId;
  }
  return payload;
}

function usesPromptCache(
  options: StreamOptions | undefined,
): options is StreamOptions & { sessionId: string } {
  return options?.cacheRetention !== "none" && Boolean(options?.sessionId);
}

/** Resolve the chat completions URL; a base URL that already ends in `/v1` is used as is. */
export function mistralChatUrl(baseUrl: string): string {
  const trimmed = (baseUrl || "https://api.mistral.ai").replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function buildHeaders(model: Model, apiKey: string, options?: StreamOptions): Headers {
  const headers = new Headers(
    mergeHeaders(
      {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      model,
      options,
    ),
  );
  // `x-affinity` routes a session to the same replica so the prompt cache hits.
  if (usesPromptCache(options) && !headers.has("x-affinity")) {
    headers.set("x-affinity", options.sessionId);
  }
  return headers;
}

function cachedPromptTokens(usage: Record<string, unknown>, promptTokens: number): number {
  const details = (usage["prompt_tokens_details"] ?? usage["prompt_token_details"]) as
    | { cached_tokens?: unknown }
    | null
    | undefined;
  const raw = details?.cached_tokens ?? usage["num_cached_tokens"] ?? 0;
  const cached = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.min(promptTokens, Math.max(0, cached));
}

/** Map a Mistral finish reason; unknown reasons are provider error stops. */
export function mapMistralStopReason(reason: string | null): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  switch (reason) {
    case null:
    case "stop":
      return { stopReason: "stop" };
    case "length":
    case "model_length":
      return { stopReason: "length" };
    case "tool_calls":
      return { stopReason: "toolUse" };
    default:
      return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
  }
}

/** Parse one SSE data payload. Returns "done" for the `[DONE]` sentinel. */
function parseChunk(data: string): StreamChunk | "done" | undefined {
  const trimmed = data.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "[DONE]") {
    return "done";
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { choices?: unknown }).choices)
  ) {
    throw new Error("Invalid Mistral streaming event");
  }
  return parsed as StreamChunk;
}

/** Translate Mistral stream chunks into the runtime's assistant event protocol. */
export async function consumeMistralChunks(
  chunks: AsyncIterable<StreamChunk>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  output.stopReason = "pending";
  stream.push({ type: "start", partial: output });
  let current: TextContent | ThinkingContent | undefined;
  const toolCalls = new Map<string | number, { index: number; json: string }>();

  const closeCurrent = () => {
    if (!current) {
      return;
    }
    const contentIndex = output.content.indexOf(current);
    if (current.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: current.text, partial: output });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: current.thinking,
        partial: output,
      });
    }
    current = undefined;
  };
  const append = (kind: "text" | "thinking", delta: string) => {
    // Some hosted models send empty deltas around thinking and tool calls; opening a block for them
    // splits thinking into several blocks, which Mistral rejects on replay.
    if (!delta) {
      return;
    }
    if (current?.type !== kind) {
      closeCurrent();
      current = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
      output.content.push(current);
      stream.push({
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    }
    const contentIndex = output.content.length - 1;
    if (current.type === "text") {
      current.text += delta;
      stream.push({ type: "text_delta", contentIndex, delta, partial: output });
    } else {
      current.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
    }
  };

  for await (const chunk of chunks) {
    if (chunk.id && !output.responseId) {
      output.responseId = chunk.id;
    }
    if (chunk.model && chunk.model !== model.id) {
      output.responseModel = chunk.model;
    }
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      const cached = cachedPromptTokens(chunk.usage, promptTokens);
      output.usage.input = Math.max(0, promptTokens - cached);
      output.usage.output = chunk.usage.completion_tokens ?? 0;
      output.usage.cacheRead = cached;
      output.usage.cacheWrite = 0;
      output.usage.totalTokens =
        chunk.usage.total_tokens ?? output.usage.input + output.usage.output + cached;
    }
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }
    if (choice.finish_reason) {
      output.rawStopReason = choice.finish_reason;
      const mapped = mapMistralStopReason(choice.finish_reason);
      output.stopReason = mapped.stopReason;
      if (mapped.errorMessage) {
        output.errorMessage = mapped.errorMessage;
      }
    }
    const content = choice.delta.content;
    if (content !== null && content !== undefined) {
      for (const item of typeof content === "string" ? [content] : content) {
        if (typeof item === "string") {
          append("text", sanitize(item));
        } else if (item.type === "thinking") {
          append(
            "thinking",
            sanitize((item.thinking ?? []).map((part) => part.text ?? "").join("")),
          );
        } else if (item.type === "text") {
          append("text", sanitize(item.text ?? ""));
        }
      }
    }
    for (const call of choice.delta.tool_calls ?? []) {
      closeCurrent();
      const id =
        call.id && call.id !== "null"
          ? call.id
          : deriveMistralToolCallId(`toolcall:${call.index ?? 0}`, 0);
      const key = call.index ?? id;
      let state = toolCalls.get(key);
      if (!state) {
        state = { index: output.content.length, json: "" };
        toolCalls.set(key, state);
        output.content.push({
          type: "toolCall",
          id,
          name: call.function.name ?? "",
          arguments: {},
        });
        stream.push({ type: "toolcall_start", contentIndex: state.index, partial: output });
      }
      const block = output.content[state.index];
      if (block?.type !== "toolCall") {
        continue;
      }
      if (call.function.name && block.name === "") {
        block.name = call.function.name;
      }
      const delta =
        typeof call.function.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {});
      state.json += delta;
      block.arguments = parseStreamingJson(state.json);
      stream.push({ type: "toolcall_delta", contentIndex: state.index, delta, partial: output });
    }
  }

  closeCurrent();
  for (const state of toolCalls.values()) {
    const block = output.content[state.index];
    if (block?.type !== "toolCall") {
      continue;
    }
    const parsed = parseToolCallArguments(state.json);
    block.arguments = parsed.arguments;
    if (parsed.argumentsError !== undefined) {
      block.argumentsError = parsed.argumentsError;
    }
    stream.push({
      type: "toolcall_end",
      contentIndex: state.index,
      toolCall: block,
      partial: output,
    });
  }
  if (output.stopReason === "pending") {
    throw new Error("Mistral stream ended without a finish reason");
  }
  calculateCost(model, output.usage);
}

async function* mistralChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk> {
  for await (const event of readSseEvents(body, signal)) {
    const chunk = parseChunk(event.data);
    if (chunk === "done") {
      return;
    }
    if (chunk) {
      yield chunk;
    }
  }
}

/** Stream a response from the native Mistral API (`api: "mistral-conversations"`). */
export function streamMistral(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const apiKey = resolveApiKey(model.provider, options?.apiKey);
    if (!apiKey) {
      throw new Error(
        `No API key for provider "${model.provider}". Set MISTRAL_API_KEY or pass apiKey.`,
      );
    }
    const payload = await applyPayloadHook(
      buildMistralPayload(model, context, options),
      model,
      options,
    );
    const response = await fetchWithRetry(
      mistralChatUrl(model.baseUrl),
      {
        method: "POST",
        headers: buildHeaders(model, apiKey, options),
        body: JSON.stringify(payload),
      },
      options,
    );
    await options?.onResponse?.({ status: response.status, headers: response.headers }, model);
    if (!response.ok) {
      const body = (await response.text()).trim();
      const detail =
        body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}...` : body;
      throw new Error(
        `Mistral API error (${response.status}): ${detail || response.statusText || "request failed"}`,
      );
    }
    if (!response.body) {
      throw new Error("Mistral response has no body");
    }
    await consumeMistralChunks(
      mistralChunks(response.body, options?.signal),
      model,
      output,
      stream,
    );
  });
}
