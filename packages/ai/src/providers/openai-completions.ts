import type OpenAI from "openai";
import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, runProviderStream } from "../http.js";
import { parseStreamingJson, parseToolCallArguments } from "../json-parse.js";
import { transformMessages } from "../transform-messages.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsCompat,
  StopReason,
  StreamOptions,
  TextContent,
} from "../types.js";
import { calculateCost } from "../usage.js";
import { createOpenAIClient } from "./openai-responses.js";

/**
 * OpenAI Chat Completions provider for OpenAI-compatible endpoints (OpenRouter, Groq, xAI, DeepSeek,
 * Mistral, vLLM, Ollama, llama.cpp, ...). Endpoint quirks come from `model.compat`, else are detected
 * from `baseUrl`.
 */

type ChatMessage = Record<string, unknown>;

export function detectCompat(model: Model): Required<OpenAICompletionsCompat> {
  const url = model.baseUrl.toLowerCase();
  const isOpenAI = url.includes("api.openai.com");
  const detected: Required<OpenAICompletionsCompat> = {
    maxTokensField: isOpenAI ? "max_completion_tokens" : "max_tokens",
    supportsReasoningEffort: isOpenAI || url.includes("x.ai") || url.includes("groq.com"),
    supportsUsageInStreaming: true,
    supportsDeveloperRole: isOpenAI && model.reasoning,
    reasoningField: url.includes("openrouter.ai") ? "reasoning" : "reasoning_content",
  };
  return { ...detected, ...(model.compat ?? {}) };
}

export function streamOpenAICompletions(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const client = createOpenAIClient(model, options);
    const payload = await applyPayloadHook(
      buildOpenAICompletionsPayload(model, context, options),
      model,
      options,
    );
    const { data, response } = await client.chat.completions
      .create(payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      .withResponse();
    await options?.onResponse?.({ status: response.status, headers: response.headers }, model);
    await consumeOpenAICompletionsChunks(data as AsyncIterable<unknown>, model, output, stream);
  });
}

/** Build the Chat Completions request body for a context. */
export function buildOpenAICompletionsPayload(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Record<string, unknown> {
  const compat = detectCompat(model);
  const messages: ChatMessage[] = [];
  if (context.systemPrompt) {
    messages.push({
      role: compat.supportsDeveloperRole ? "developer" : "system",
      content: context.systemPrompt,
    });
  }
  messages.push(...convertMessages(context.messages, model));
  const payload: Record<string, unknown> = { model: model.id, messages, stream: true };
  if (compat.supportsUsageInStreaming) {
    payload["stream_options"] = { include_usage: true };
  }
  if (options?.maxTokens !== undefined) {
    payload[compat.maxTokensField] = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    payload["temperature"] = options.temperature;
  }
  if (
    options?.sessionId &&
    options.cacheRetention !== "none" &&
    model.baseUrl.includes("api.openai.com")
  ) {
    payload["prompt_cache_key"] = options.sessionId;
  }
  if (context.tools && context.tools.length > 0) {
    payload["tools"] = context.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options?.toolChoice !== undefined) {
    const choice = options.toolChoice;
    payload["tool_choice"] =
      typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
  }
  if (model.reasoning && options?.reasoning && compat.supportsReasoningEffort) {
    payload["reasoning_effort"] = options.reasoning === "xhigh" ? "high" : options.reasoning;
  }
  return payload;
}

function userContent(content: string | (TextContent | ImageContent)[]): unknown {
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
  );
}

function convertMessages(messages: readonly Message[], model: Model): ChatMessage[] {
  const result: ChatMessage[] = [];
  const normalize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  let pendingImages: ImageContent[] = [];
  const flushImages = () => {
    if (pendingImages.length > 0) {
      result.push({
        role: "user",
        content: userContent([
          { type: "text", text: "Images from the tool results:" },
          ...pendingImages,
        ]),
      });
      pendingImages = [];
    }
  };
  for (const message of transformMessages(messages, model, normalize)) {
    if (message.role === "toolResult") {
      const text = message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      pendingImages.push(
        ...message.content.filter((block): block is ImageContent => block.type === "image"),
      );
      result.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: text.length > 0 ? text : "(no output)",
      });
      continue;
    }
    // Chat Completions only accepts images in user messages: send tool images after the tool results.
    flushImages();
    if (message.role === "user") {
      result.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = message.content.flatMap((block) =>
      block.type === "toolCall"
        ? [
            {
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.arguments) },
            },
          ]
        : [],
    );
    if (text.length === 0 && toolCalls.length === 0) {
      continue;
    }
    result.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  flushImages();
  return result;
}

function mapFinishReason(reason: string | null | undefined): StopReason | undefined {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return undefined;
  }
}

interface ChunkDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
  id?: string;
  model?: string;
  choices?: { delta?: ChunkDelta; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/** Translate Chat Completions chunks into the runtime's assistant event protocol. */
export async function consumeOpenAICompletionsChunks(
  chunks: AsyncIterable<unknown>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const compat = detectCompat(model);
  let started = false;
  let current: { kind: "text" | "thinking"; index: number } | undefined;
  const toolCalls = new Map<number, { index: number; json: string }>();
  let finish: string | null | undefined;

  const start = () => {
    if (!started) {
      started = true;
      stream.push({ type: "start", partial: output });
    }
  };
  const closeCurrent = () => {
    if (!current) {
      return;
    }
    const block = output.content[current.index];
    if (current.kind === "text" && block?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: current.index,
        content: block.text,
        partial: output,
      });
    } else if (current.kind === "thinking" && block?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: current.index,
        content: block.thinking,
        partial: output,
      });
    }
    current = undefined;
  };
  const appendTo = (kind: "text" | "thinking", delta: string) => {
    if (current?.kind !== kind) {
      closeCurrent();
      const index = output.content.length;
      output.content.push(
        kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      );
      current = { kind, index };
      stream.push({
        type: kind === "text" ? "text_start" : "thinking_start",
        contentIndex: index,
        partial: output,
      });
    }
    const block = output.content[current.index];
    if (block?.type === "text") {
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex: current.index, delta, partial: output });
    } else if (block?.type === "thinking") {
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: current.index, delta, partial: output });
    }
  };

  for await (const raw of chunks) {
    const chunk = raw as Chunk;
    start();
    if (chunk.id && !output.responseId) {
      output.responseId = chunk.id;
    }
    if (chunk.model && chunk.model !== model.id) {
      output.responseModel = chunk.model;
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      output.usage.input = (chunk.usage.prompt_tokens ?? 0) - cached;
      output.usage.cacheRead = cached;
      output.usage.output = chunk.usage.completion_tokens ?? 0;
      const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens;
      if (reasoning !== undefined) {
        output.usage.reasoning = reasoning;
      }
      output.usage.totalTokens =
        chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + output.usage.output;
    }
    const choice = chunk.choices?.[0];
    if (!choice) {
      continue;
    }
    const delta = choice.delta ?? {};
    const reasoning = delta[compat.reasoningField] ?? delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      appendTo("thinking", reasoning);
    }
    if (delta.content) {
      appendTo("text", delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      let state = toolCalls.get(call.index);
      if (!state) {
        closeCurrent();
        state = { index: output.content.length, json: "" };
        toolCalls.set(call.index, state);
        output.content.push({
          type: "toolCall",
          id: call.id ?? `call_${call.index}`,
          name: call.function?.name ?? "",
          arguments: {},
        });
        stream.push({ type: "toolcall_start", contentIndex: state.index, partial: output });
      }
      const block = output.content[state.index];
      if (block?.type !== "toolCall") {
        continue;
      }
      if (call.function?.name && block.name === "") {
        block.name = call.function.name;
      }
      const argumentsDelta = call.function?.arguments ?? "";
      if (argumentsDelta.length > 0) {
        state.json += argumentsDelta;
        block.arguments = parseStreamingJson(state.json);
        stream.push({
          type: "toolcall_delta",
          contentIndex: state.index,
          delta: argumentsDelta,
          partial: output,
        });
      }
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason;
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
  if (finish) {
    output.rawStopReason = finish;
  }
  const mapped = mapFinishReason(finish) ?? (toolCalls.size > 0 ? "toolUse" : "stop");
  output.stopReason = mapped;
  if (mapped === "error") {
    output.errorMessage = "The response was stopped by the content filter.";
  }
  calculateCost(model, output.usage);
}
