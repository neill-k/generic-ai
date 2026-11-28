import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, mergeHeaders, runProviderStream } from "../http.js";
import { parseStreamingJson, parseToolCallArguments } from "../json-parse.js";
import { sanitizeToolCallId, transformMessages } from "../transform-messages.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingLevel,
  ToolResultMessage,
} from "../types.js";
import { calculateCost } from "../usage.js";
import { resolveApiKey } from "./env.js";

/**
 * Anthropic Messages API provider, built on the official `@anthropic-ai/sdk` streaming client.
 *
 * - Adaptive thinking + `output_config.effort` for Claude 4.6+ (`thinkingMode: "adaptive"`), a thinking
 *   token budget for older models (`thinkingMode: "budget"`).
 * - Prompt caching: the system prompt, the tool list and the last user turn carry `cache_control`.
 * - Thinking blocks are replayed with their signatures; redacted thinking round-trips opaquely.
 */

type AnthropicContentBlock = Record<string, unknown>;
type AnthropicMessageParam = { role: "user" | "assistant"; content: AnthropicContentBlock[] };

const EFFORT: Record<ThinkingLevel, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const DEFAULT_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 32_768,
};

const ERROR_IMAGE_PLACEHOLDER = "(image omitted from error result)";

/**
 * Claude plan (Pro/Max) sign-in tokens. Anthropic's terms don't allow third-party apps to use them,
 * so requests carrying one are refused here instead of being sent.
 */
export function isClaudeSubscriptionToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

export function streamAnthropic(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const apiKey = resolveApiKey(model.provider, options?.apiKey);
    if (!apiKey) {
      throw new Error(
        `No API key for provider "${model.provider}". Set ANTHROPIC_API_KEY or pass apiKey.`,
      );
    }
    if (isClaudeSubscriptionToken(apiKey)) {
      throw new Error(
        "Claude plan sign-in tokens can't be used here: Anthropic's terms don't allow third-party apps to use a Claude plan. Use an Anthropic API key.",
      );
    }
    const client = createClient(model, apiKey, options);
    const payload = await applyPayloadHook(
      buildAnthropicPayload(model, context, options),
      model,
      options,
    );
    const { data, response } = await client.messages
      .create(payload as Anthropic.MessageCreateParamsStreaming, {
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      .withResponse();
    await options?.onResponse?.({ status: response.status, headers: response.headers }, model);
    await consumeAnthropicEvents(data, model, output, stream);
  });
}

function createClient(model: Model, apiKey: string, options: StreamOptions | undefined): Anthropic {
  // Copilot tokens authenticate with a bearer header.
  if (model.provider === "github-copilot") {
    return new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: mergeHeaders({ accept: "application/json" }, model, options),
      maxRetries: options?.maxRetries ?? 2,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
    });
  }
  const headers = mergeHeaders({}, model, options);
  return new Anthropic({
    apiKey,
    baseURL: model.baseUrl,
    defaultHeaders: headers,
    maxRetries: options?.maxRetries ?? 2,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}

/** Build the Messages API request body for a context. Exported for tests and payload inspection. */
export function buildAnthropicPayload(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Record<string, unknown> {
  const toolName = (name: string) => name;
  const messages = convertMessages(context.messages, model, toolName);
  const cacheControl = anthropicCacheControl(options?.cacheRetention);
  if (cacheControl) {
    markLastUserTurnCacheable(messages, cacheControl);
  }
  const payload: Record<string, unknown> = {
    model: model.id,
    max_tokens: options?.maxTokens ?? model.maxTokens,
    messages,
    stream: true,
  };
  if (context.systemPrompt) {
    payload["system"] = [
      {
        type: "text",
        text: context.systemPrompt,
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }
  if (context.tools && context.tools.length > 0) {
    payload["tools"] = context.tools.map((tool, index, tools) => ({
      name: toolName(tool.name),
      description: tool.description,
      input_schema: tool.parameters,
      ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
    }));
  }
  if (options?.toolChoice !== undefined) {
    const choice = options.toolChoice;
    payload["tool_choice"] =
      choice === "auto"
        ? { type: "auto" }
        : choice === "none"
          ? { type: "none" }
          : choice === "required"
            ? { type: "any" }
            : { type: "tool", name: toolName(choice.name) };
  }
  if (options?.temperature !== undefined) {
    payload["temperature"] = options.temperature;
  }
  applyThinking(payload, model, options);
  return payload;
}

function applyThinking(
  payload: Record<string, unknown>,
  model: Model,
  options: StreamOptions | undefined,
): void {
  const level = options?.reasoning;
  const mode = model.thinkingMode ?? (model.reasoning ? "adaptive" : "none");
  if (!level || mode === "none") {
    return;
  }
  if (mode === "adaptive") {
    payload["thinking"] = { type: "adaptive", display: "summarized" };
    payload["output_config"] = { effort: EFFORT[level] };
    return;
  }
  const budget = options?.thinkingBudgets?.[level] ?? DEFAULT_BUDGETS[level];
  const maxTokens = payload["max_tokens"] as number;
  // The budget must stay below max_tokens; leave room for the visible answer.
  payload["max_tokens"] = Math.max(maxTokens, budget + 4096);
  payload["thinking"] = { type: "enabled", budget_tokens: budget };
}

function imageBlock(image: ImageContent): AnthropicContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mimeType, data: image.data },
  };
}

function userContent(content: string | (TextContent | ImageContent)[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((block): AnthropicContentBlock[] => {
    if (block.type === "image") {
      return [imageBlock(block)];
    }
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  });
}

function toolResultBlock(message: ToolResultMessage): AnthropicContentBlock {
  // The API rejects images inside error results.
  const content = message.content.flatMap((block): AnthropicContentBlock[] => {
    if (block.type === "image") {
      return message.isError
        ? [{ type: "text", text: ERROR_IMAGE_PLACEHOLDER }]
        : [imageBlock(block)];
    }
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  });
  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content:
      content.length > 0
        ? content
        : [{ type: "text", text: message.isError ? "Error" : "(no output)" }],
    ...(message.isError ? { is_error: true } : {}),
  };
}

function assistantContent(
  message: AssistantMessage,
  toolName: (name: string) => string,
): AnthropicContentBlock[] {
  return message.content.flatMap((block): AnthropicContentBlock[] => {
    switch (block.type) {
      case "text":
        return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
      case "thinking":
        if (block.redacted) {
          return block.thinkingSignature
            ? [{ type: "redacted_thinking", data: block.thinkingSignature }]
            : [];
        }
        if (block.thinkingSignature) {
          return [
            { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature },
          ];
        }
        // Unsigned thinking cannot be replayed as thinking; keep its text.
        return block.thinking.trim().length > 0 ? [{ type: "text", text: block.thinking }] : [];
      default:
        return [
          { type: "tool_use", id: block.id, name: toolName(block.name), input: block.arguments },
        ];
    }
  });
}

function convertMessages(
  messages: readonly Message[],
  model: Model,
  toolName: (name: string) => string,
): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];
  const push = (role: "user" | "assistant", content: AnthropicContentBlock[]) => {
    if (content.length === 0) {
      return;
    }
    const last = result.at(-1);
    // Consecutive same-role turns merge, which keeps all tool results of a turn in one user message.
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      result.push({ role, content: [...content] });
    }
  };
  for (const message of transformMessages(messages, model, (id) => sanitizeToolCallId(id))) {
    if (message.role === "user") {
      push("user", userContent(message.content));
    } else if (message.role === "assistant") {
      push("assistant", assistantContent(message, toolName));
    } else {
      push("user", [toolResultBlock(message)]);
    }
  }
  return result;
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

function anthropicCacheControl(
  retention: StreamOptions["cacheRetention"],
): AnthropicCacheControl | undefined {
  if (retention === "none") {
    return undefined;
  }
  return retention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function markLastUserTurnCacheable(
  messages: AnthropicMessageParam[],
  cacheControl: AnthropicCacheControl,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const last = message.content.at(-1);
    if (last) {
      last["cache_control"] = cacheControl;
    }
    return;
  }
}

function mapStopReason(reason: string | null | undefined): {
  stopReason: StopReason;
  error?: string;
} {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case null:
    case undefined:
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        error: "The model declined to respond (stop_reason: refusal).",
      };
    case "model_context_window_exceeded":
      return { stopReason: "error", error: "The request exceeded the model's context window." };
    default:
      return { stopReason: "stop" };
  }
}

type BlockState =
  | { readonly kind: "text"; readonly index: number }
  | { readonly kind: "thinking"; readonly index: number }
  | { readonly kind: "toolCall"; readonly index: number; json: string }
  | { readonly kind: "ignored" };

interface AnthropicUsageFields {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function applyUsage(
  output: AssistantMessage,
  usage: AnthropicUsageFields | undefined | null,
): void {
  if (!usage) {
    return;
  }
  if (typeof usage.input_tokens === "number") {
    output.usage.input = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    output.usage.output = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    output.usage.cacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  }
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/**
 * Translate Anthropic stream events into the runtime's assistant event protocol. Accepts any async
 * iterable of raw events, so tests can replay recorded streams without HTTP.
 */
export async function consumeAnthropicEvents(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent | { type: string; [key: string]: unknown }>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const blocks = new Map<number, BlockState>();
  let started = false;
  const start = () => {
    if (!started) {
      started = true;
      stream.push({ type: "start", partial: output });
    }
  };

  for await (const raw of events) {
    const event = raw as
      | Anthropic.RawMessageStreamEvent
      | { type: "error"; error?: { message?: string } };
    switch (event.type) {
      case "message_start": {
        output.responseId = event.message.id;
        if (event.message.model && event.message.model !== model.id) {
          output.responseModel = event.message.model;
        }
        applyUsage(output, event.message.usage);
        start();
        break;
      }
      case "content_block_start": {
        start();
        const block = event.content_block;
        const index = output.content.length;
        if (block.type === "text") {
          output.content.push({ type: "text", text: "" });
          blocks.set(event.index, { kind: "text", index });
          stream.push({ type: "text_start", contentIndex: index, partial: output });
        } else if (block.type === "thinking") {
          output.content.push({ type: "thinking", thinking: "" });
          blocks.set(event.index, { kind: "thinking", index });
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        } else if (block.type === "redacted_thinking") {
          output.content.push({
            type: "thinking",
            thinking: "",
            redacted: true,
            thinkingSignature: block.data,
          });
          blocks.set(event.index, { kind: "thinking", index });
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        } else if (block.type === "tool_use") {
          output.content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: {},
          });
          blocks.set(event.index, { kind: "toolCall", index, json: "" });
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        } else {
          blocks.set(event.index, { kind: "ignored" });
        }
        break;
      }
      case "content_block_delta": {
        const state = blocks.get(event.index);
        if (!state || state.kind === "ignored") {
          break;
        }
        const delta = event.delta;
        const block = output.content[state.index];
        if (delta.type === "text_delta" && block?.type === "text") {
          const text = delta.text;
          block.text += text;
          stream.push({
            type: "text_delta",
            contentIndex: state.index,
            delta: text,
            partial: output,
          });
        } else if (delta.type === "thinking_delta" && block?.type === "thinking") {
          const text = delta.thinking;
          block.thinking += text;
          stream.push({
            type: "thinking_delta",
            contentIndex: state.index,
            delta: text,
            partial: output,
          });
        } else if (delta.type === "signature_delta" && block?.type === "thinking") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
        } else if (
          delta.type === "input_json_delta" &&
          block?.type === "toolCall" &&
          state.kind === "toolCall"
        ) {
          const text = delta.partial_json;
          state.json += text;
          block.arguments = parseStreamingJson(state.json);
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.index,
            delta: text,
            partial: output,
          });
        }
        break;
      }
      case "content_block_stop": {
        const state = blocks.get(event.index);
        if (!state || state.kind === "ignored") {
          break;
        }
        const block = output.content[state.index];
        if (state.kind === "text" && block?.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: state.index,
            content: block.text,
            partial: output,
          });
        } else if (state.kind === "thinking" && block?.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: state.index,
            content: block.thinking,
            partial: output,
          });
        } else if (state.kind === "toolCall" && block?.type === "toolCall") {
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
        break;
      }
      case "message_delta": {
        const mapped = mapStopReason(event.delta.stop_reason);
        output.stopReason = mapped.stopReason;
        if (event.delta.stop_reason) {
          output.rawStopReason = event.delta.stop_reason;
        }
        if (mapped.error !== undefined) {
          output.errorMessage = mapped.error;
        }
        applyUsage(output, event.usage as AnthropicUsageFields);
        break;
      }
      case "message_stop":
        break;
      case "error":
        throw new Error(event.error?.message ?? "Anthropic stream error");
      default:
        break;
    }
  }
  calculateCost(model, output.usage);
}
