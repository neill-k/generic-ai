import OpenAI from "openai";
import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, mergeHeaders, runProviderStream } from "../http.js";
import { parseStreamingJson, parseToolCallArguments } from "../json-parse.js";
import { transformMessages } from "../transform-messages.js";
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
} from "../types.js";
import { calculateCost } from "../usage.js";
import { resolveApiKey } from "./env.js";

/**
 * OpenAI Responses API provider, built on the official `openai` SDK.
 *
 * Runs stateless (`store: false`) and replays encrypted reasoning items, so multi-turn tool use keeps
 * the model's reasoning without server-side conversation state. Tool-call ids are stored as
 * `call_id|item_id`; other providers see a sanitised form.
 */

type InputItem = Record<string, unknown>;

export function streamOpenAIResponses(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const client = createOpenAIClient(model, options);
    const payload = await applyPayloadHook(
      buildOpenAIResponsesPayload(model, context, options),
      model,
      options,
    );
    const { data, response } = await client.responses
      .create(payload as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, {
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      .withResponse();
    await options?.onResponse?.({ status: response.status, headers: response.headers }, model);
    await consumeOpenAIResponsesEvents(
      data as AsyncIterable<{ type: string }>,
      model,
      output,
      stream,
    );
  });
}

export function createOpenAIClient(model: Model, options: StreamOptions | undefined): OpenAI {
  const apiKey = resolveApiKey(model.provider, options?.apiKey);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${model.provider}". Pass apiKey or set the provider's API key variable.`,
    );
  }
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    defaultHeaders: mergeHeaders({}, model, options),
    maxRetries: options?.maxRetries ?? 2,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}

/** Build the Responses API request body for a context. */
export function buildOpenAIResponsesPayload(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: model.id,
    input: convertInput(context.messages, model),
    stream: true,
    store: false,
  };
  if (context.systemPrompt) {
    payload["instructions"] = context.systemPrompt;
  }
  if (options?.maxTokens !== undefined) {
    payload["max_output_tokens"] = options.maxTokens;
  }
  if (options?.sessionId && options.cacheRetention !== "none") {
    payload["prompt_cache_key"] = options.sessionId;
  }
  if (options?.cacheRetention === "long") {
    payload["prompt_cache_retention"] = "24h";
  }
  if (options?.temperature !== undefined) {
    payload["temperature"] = options.temperature;
  }
  if (context.tools && context.tools.length > 0) {
    payload["tools"] = context.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
  }
  if (options?.toolChoice !== undefined) {
    const choice = options.toolChoice;
    payload["tool_choice"] =
      typeof choice === "string" ? choice : { type: "function", name: choice.name };
  }
  if (model.reasoning) {
    if (options?.reasoning) {
      payload["reasoning"] = { effort: options.reasoning, summary: "auto" };
    }
    payload["include"] = ["reasoning.encrypted_content"];
  }
  return payload;
}

function splitToolCallId(id: string): { callId: string; itemId: string | undefined } {
  const separator = id.indexOf("|");
  return separator === -1
    ? { callId: id, itemId: undefined }
    : { callId: id.slice(0, separator), itemId: id.slice(separator + 1) };
}

function userParts(content: string | (TextContent | ImageContent)[]): InputItem[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  return content.map((block) =>
    block.type === "text"
      ? { type: "input_text", text: block.text }
      : {
          type: "input_image",
          detail: "auto",
          image_url: `data:${block.mimeType};base64,${block.data}`,
        },
  );
}

function sameModel(message: AssistantMessage, model: Model): boolean {
  return (
    message.provider === model.provider && message.api === model.api && message.model === model.id
  );
}

function convertInput(messages: readonly Message[], model: Model): InputItem[] {
  const items: InputItem[] = [];
  // Responses call ids must stay short and free of the "|" separator when they come from elsewhere.
  const normalize = (id: string, _model: Model, source: AssistantMessage) =>
    source.api === "openai-responses" ? id : id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  for (const message of transformMessages(messages, model, normalize)) {
    if (message.role === "user") {
      items.push({ role: "user", content: userParts(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const images = message.content.filter(
        (block): block is ImageContent => block.type === "image",
      );
      items.push({
        type: "function_call_output",
        call_id: splitToolCallId(message.toolCallId).callId,
        output: text.length > 0 ? text : images.length > 0 ? "(see attached image)" : "(no output)",
      });
      if (images.length > 0) {
        items.push({ role: "user", content: userParts(images) });
      }
      continue;
    }
    const replayable = sameModel(message, model);
    for (const block of message.content) {
      if (block.type === "thinking") {
        const item = replayable ? parseReasoningItem(block) : undefined;
        if (item) {
          items.push(item);
        }
      } else if (block.type === "text") {
        if (block.text.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            ...(replayable && block.textSignature?.startsWith("msg_")
              ? { id: block.textSignature }
              : {}),
          });
        }
      } else {
        const { callId, itemId } = splitToolCallId(block.id);
        items.push({
          type: "function_call",
          call_id: callId,
          name: block.name,
          arguments: JSON.stringify(block.arguments),
          ...(replayable && itemId ? { id: itemId } : {}),
        });
      }
    }
  }
  return items;
}

function parseReasoningItem(block: ThinkingContent): InputItem | undefined {
  if (!block.thinkingSignature) {
    return undefined;
  }
  try {
    const item = JSON.parse(block.thinkingSignature) as InputItem;
    return item["type"] === "reasoning" ? item : undefined;
  } catch {
    return undefined;
  }
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

function applyUsage(output: AssistantMessage, usage: ResponsesUsage | null | undefined): void {
  if (!usage) {
    return;
  }
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  output.usage.input = (usage.input_tokens ?? 0) - cached;
  output.usage.cacheRead = cached;
  output.usage.output = usage.output_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) {
    output.usage.reasoning = reasoning;
  }
  output.usage.totalTokens = usage.total_tokens ?? (usage.input_tokens ?? 0) + output.usage.output;
}

type ItemState =
  | { readonly kind: "text"; readonly index: number }
  | { readonly kind: "thinking"; readonly index: number }
  | { readonly kind: "toolCall"; readonly index: number; json: string };

/** Translate Responses stream events into the runtime's assistant event protocol. */
export async function consumeOpenAIResponsesEvents(
  events: AsyncIterable<{ type: string }>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const items = new Map<string, ItemState>();
  let started = false;
  const start = () => {
    if (!started) {
      started = true;
      stream.push({ type: "start", partial: output });
    }
  };
  let sawToolCall = false;

  for await (const raw of events) {
    const event = raw as { type: string; [key: string]: unknown };
    switch (event.type) {
      case "response.created": {
        const response = event["response"] as { id?: string; model?: string } | undefined;
        if (response?.id) {
          output.responseId = response.id;
        }
        if (response?.model && response.model !== model.id) {
          output.responseModel = response.model;
        }
        start();
        break;
      }
      case "response.output_item.added": {
        start();
        const item = event["item"] as {
          type: string;
          id?: string;
          call_id?: string;
          name?: string;
        };
        const key = item.id ?? String(event["output_index"]);
        const index = output.content.length;
        if (item.type === "reasoning") {
          output.content.push({ type: "thinking", thinking: "" });
          items.set(key, { kind: "thinking", index });
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        } else if (item.type === "message") {
          output.content.push({ type: "text", text: "" });
          items.set(key, { kind: "text", index });
          stream.push({ type: "text_start", contentIndex: index, partial: output });
        } else if (item.type === "function_call") {
          sawToolCall = true;
          output.content.push({
            type: "toolCall",
            id: item.id ? `${item.call_id}|${item.id}` : String(item.call_id),
            name: String(item.name),
            arguments: {},
          });
          items.set(key, { kind: "toolCall", index, json: "" });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const state = items.get(String(event["item_id"]));
        const block = state ? output.content[state.index] : undefined;
        if (state && block?.type === "thinking") {
          const delta = String(event["delta"] ?? "");
          block.thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: state.index,
            delta,
            partial: output,
          });
        }
        break;
      }
      case "response.reasoning_summary_part.done": {
        const state = items.get(String(event["item_id"]));
        const block = state ? output.content[state.index] : undefined;
        if (state && block?.type === "thinking") {
          block.thinking += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: state.index,
            delta: "\n\n",
            partial: output,
          });
        }
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const state = items.get(String(event["item_id"]));
        const block = state ? output.content[state.index] : undefined;
        if (state && block?.type === "text") {
          const delta = String(event["delta"] ?? "");
          block.text += delta;
          stream.push({ type: "text_delta", contentIndex: state.index, delta, partial: output });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const state = items.get(String(event["item_id"]));
        const block = state ? output.content[state.index] : undefined;
        if (state?.kind === "toolCall" && block?.type === "toolCall") {
          const delta = String(event["delta"] ?? "");
          state.json += delta;
          block.arguments = parseStreamingJson(state.json);
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.index,
            delta,
            partial: output,
          });
        }
        break;
      }
      case "response.output_item.done": {
        const item = event["item"] as { type: string; id?: string; [key: string]: unknown };
        const state = items.get(item.id ?? String(event["output_index"]));
        if (!state) {
          break;
        }
        finishItem(item, state, output, stream);
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = event["response"] as {
          usage?: ResponsesUsage;
          status?: string;
          incomplete_details?: { reason?: string } | null;
        };
        applyUsage(output, response.usage);
        if (event.type === "response.incomplete") {
          output.rawStopReason = response.incomplete_details?.reason ?? "incomplete";
          output.stopReason =
            response.incomplete_details?.reason === "content_filter" ? "error" : "length";
          if (output.stopReason === "error") {
            output.errorMessage = "The response was stopped by the content filter.";
          }
        } else {
          output.stopReason = sawToolCall ? "toolUse" : "stop";
        }
        break;
      }
      case "response.failed": {
        const response = event["response"] as {
          error?: { message?: string } | null;
          usage?: ResponsesUsage;
        };
        applyUsage(output, response.usage);
        throw new Error(response.error?.message ?? "OpenAI response failed");
      }
      case "error":
        throw new Error(String(event["message"] ?? "OpenAI stream error"));
      default:
        break;
    }
  }
  calculateCost(model, output.usage);
}

function finishItem(
  item: { type: string; id?: string; [key: string]: unknown },
  state: ItemState,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const block = output.content[state.index];
  if (state.kind === "thinking" && block?.type === "thinking") {
    const summary = (item["summary"] as { text?: string }[] | undefined) ?? [];
    if (block.thinking.trim() === "" && summary.length > 0) {
      block.thinking = summary.map((part) => part.text ?? "").join("\n\n");
    }
    block.thinking = block.thinking.trim();
    block.thinkingSignature = JSON.stringify(item);
    stream.push({
      type: "thinking_end",
      contentIndex: state.index,
      content: block.thinking,
      partial: output,
    });
  } else if (state.kind === "text" && block?.type === "text") {
    const parts =
      (item["content"] as { type: string; text?: string; refusal?: string }[] | undefined) ?? [];
    const text = parts.map((part) => part.text ?? part.refusal ?? "").join("");
    if (text.length > 0) {
      block.text = text;
    }
    if (item.id) {
      block.textSignature = item.id;
    }
    stream.push({
      type: "text_end",
      contentIndex: state.index,
      content: block.text,
      partial: output,
    });
  } else if (state.kind === "toolCall" && block?.type === "toolCall") {
    const parsed = parseToolCallArguments(
      typeof item["arguments"] === "string" ? item["arguments"] : state.json,
    );
    block.arguments = parsed.arguments;
    if (parsed.argumentsError !== undefined) {
      block.argumentsError = parsed.argumentsError;
    }
    stream.push({
      type: "toolcall_end",
      contentIndex: state.index,
      toolCall: block satisfies ToolCall,
      partial: output,
    });
  }
}
