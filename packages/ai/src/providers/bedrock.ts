// Amazon Bedrock Converse Stream provider. Ported from pi (badlogic/pi-mono,
// packages/ai/src/api/bedrock-converse-stream.ts). Copyright (c) 2026 Earendil Inc. MIT License; see
// THIRD_PARTY_NOTICES.md.

import {
  type Message as BedrockMessage,
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  BedrockRuntimeServiceException,
  type Tool as BedrockTool,
  type ContentBlock,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type SystemContentBlock,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, runProviderStream } from "../http.js";
import { parseStreamingJson, parseToolCallArguments } from "../json-parse.js";
import { transformMessages } from "../transform-messages.js";
import type {
  AssistantMessage,
  CacheRetention,
  Context,
  ImageContent,
  JsonValue,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolChoice,
  ToolResultMessage,
} from "../types.js";
import { calculateCost } from "../usage.js";

type Env = Readonly<Record<string, string | undefined>>;

const EMPTY_TEXT_PLACEHOLDER = "<empty>";
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";
const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image omitted from error result)";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const DATA_RETENTION_DOCS_URL =
  "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

const ERROR_PREFIXES: Record<string, string> = {
  InternalServerException: "Internal server error",
  ModelStreamErrorException: "Model stream error",
  ValidationException: "Validation error",
  ThrottlingException: "Throttling error",
  ServiceUnavailableException: "Service unavailable",
};

const BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  // Budget-based Claude clamps extended levels to high.
  xhigh: 16_384,
};

const OPENAI_GPT_EFFORT: Record<ThinkingLevel, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const OPENAI_GPT_OSS_EFFORT: Record<ThinkingLevel, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

// ---------------------------------------------------------------------------
// Model families
// ---------------------------------------------------------------------------

/** Lower-cased id and name, raw and with separators folded to "-", for family matching. */
function candidates(model: Pick<Model, "id" | "name">): string[] {
  return [model.id, model.name].flatMap((value) => {
    const lower = (value ?? "").toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

function matchesAny(model: Pick<Model, "id" | "name">, needles: readonly string[]): boolean {
  return candidates(model).some((value) => needles.some((needle) => value.includes(needle)));
}

/** Claude on Bedrock: by id, or by name for application inference profiles whose ARN hides it. */
export function isBedrockClaude(model: Pick<Model, "id" | "name">): boolean {
  const id = model.id.toLowerCase();
  const name = (model.name ?? "").toLowerCase();
  return (
    id.includes("anthropic.claude") || id.includes("anthropic/claude") || name.includes("claude")
  );
}

const ADAPTIVE = [
  "opus-4-6",
  "opus-4-7",
  "opus-4-8",
  "opus-5",
  "sonnet-4-6",
  "sonnet-5",
  "haiku-5",
  "fable-5",
];
const NATIVE_XHIGH = ["opus-4-7", "opus-4-8", "opus-5", "sonnet-5", "haiku-5", "fable-5"];

/** Adaptive thinking with an effort level (Claude 4.6+), else a token budget. */
export function bedrockUsesAdaptiveThinking(model: Model): boolean {
  if (model.thinkingMode !== undefined) {
    return model.thinkingMode === "adaptive";
  }
  return matchesAny(model, ADAPTIVE);
}

/**
 * Prompt caching: Claude 3.5 Haiku, 3.7 Sonnet, 4.x and 5. Application inference profiles whose
 * names hide the model can force cache points with `AWS_BEDROCK_FORCE_CACHE=1`. Nova caches on its own.
 */
export function bedrockSupportsPromptCaching(model: Model, env: Env = process.env): boolean {
  const values = candidates(model);
  if (!values.some((value) => value.includes("claude"))) {
    return env["AWS_BEDROCK_FORCE_CACHE"] === "1";
  }
  return values.some(
    (value) =>
      value.includes("fable-5") ||
      value.includes("opus-5") ||
      value.includes("sonnet-5") ||
      value.includes("haiku-5") ||
      value.includes("-4-") ||
      value.includes("claude-3-7-sonnet") ||
      value.includes("claude-3-5-haiku"),
  );
}

function isGovCloud(model: Model, env: Env): boolean {
  const region = configuredRegion(env);
  if (region?.toLowerCase().startsWith("us-gov-")) {
    return true;
  }
  const id = model.id.toLowerCase();
  return id.startsWith("us-gov.") || id.startsWith("arn:aws-us-gov:");
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

function configuredRegion(env: Env): string | undefined {
  return env["AWS_REGION"] || env["AWS_DEFAULT_REGION"] || undefined;
}

function standardEndpointRegion(baseUrl: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const { hostname } = new URL(baseUrl);
    return hostname
      .toLowerCase()
      .match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Bedrock client configuration from the model, options and environment:
 *
 * - Region: an inference-profile ARN's region, then `AWS_REGION`/`AWS_DEFAULT_REGION`, then the
 *   region of a standard endpoint base URL, then `us-east-1` unless `AWS_PROFILE` supplies one.
 * - Endpoint: a custom base URL (VPC endpoint, proxy) is always used; a standard
 *   `bedrock-runtime.<region>.amazonaws.com` URL only when no region or profile is configured.
 * - Auth: a Bedrock API key (`apiKey` or `AWS_BEARER_TOKEN_BEDROCK`) as a bearer token, else
 *   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, else the SDK default chain
 *   (`AWS_PROFILE`, SSO, instance roles). A configured profile wins over ambient keys.
 *   `AWS_BEDROCK_SKIP_AUTH=1` sends dummy credentials for proxies that add their own.
 */
export function resolveBedrockClientConfig(
  model: Model,
  options: StreamOptions | undefined,
  env: Env = process.env,
): BedrockRuntimeClientConfig {
  const profile = env["AWS_PROFILE"] || undefined;
  const region = configuredRegion(env);
  const endpointRegion = standardEndpointRegion(model.baseUrl);
  const useEndpoint = model.baseUrl !== "" && (!endpointRegion || (!region && !profile));
  const config: BedrockRuntimeClientConfig = {
    ...(profile ? { profile } : {}),
    customUserAgent: [["generic-ai"]],
    // The SDK retries throttling, transient and network failures itself.
    maxAttempts: Math.max(0, options?.maxRetries ?? 2) + 1,
  };
  if (useEndpoint) {
    config.endpoint = model.baseUrl;
  }
  const arnRegion = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/)?.[1];
  if (arnRegion) {
    config.region = arnRegion;
  } else if (region) {
    config.region = region;
  } else if (endpointRegion && useEndpoint) {
    config.region = endpointRegion;
  } else if (!profile) {
    config.region = "us-east-1";
  }

  const skipAuth = env["AWS_BEDROCK_SKIP_AUTH"] === "1";
  const bearerToken = options?.apiKey || env["AWS_BEARER_TOKEN_BEDROCK"] || undefined;
  if (skipAuth) {
    config.credentials = { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
  } else if (bearerToken) {
    config.token = { token: bearerToken };
    config.authSchemePreference = ["httpBearerAuth"];
  } else if (!profile && env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) {
    config.credentials = {
      accessKeyId: env["AWS_ACCESS_KEY_ID"],
      secretAccessKey: env["AWS_SECRET_ACCESS_KEY"],
      ...(env["AWS_SESSION_TOKEN"] ? { sessionToken: env["AWS_SESSION_TOKEN"] } : {}),
    };
  }
  if (options?.fetch) {
    config.requestHandler = createFetchRequestHandler(options.fetch);
  }
  return config;
}

interface SmithyRequest {
  protocol: string;
  hostname: string;
  port?: number;
  method: string;
  path: string;
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A Smithy request handler over `fetch`, used when the caller passes `options.fetch` (tests, proxies,
 * custom transports). Requests are signed before they reach the handler, so signing is unaffected.
 */
function createFetchRequestHandler(doFetch: typeof globalThis.fetch) {
  return {
    async handle(request: SmithyRequest, handlerOptions?: { abortSignal?: AbortSignal }) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
          query.append(key, item ?? "");
        }
      }
      const search = query.toString();
      const port = request.port ? `:${request.port}` : "";
      const url = `${request.protocol}//${request.hostname}${port}${request.path}${search ? `?${search}` : ""}`;
      const response = await doFetch(url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined && request.body !== null
          ? { body: request.body as NonNullable<RequestInit["body"]> }
          : {}),
        ...(handlerOptions?.abortSignal ? { signal: handlerOptions.abortSignal } : {}),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        response: {
          statusCode: response.status,
          reason: response.statusText,
          headers,
          body: response.body ?? new Uint8Array(),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };
}

/**
 * Attach caller headers before signing, so they are covered by SigV4. Headers that take part in
 * signing or auth (`x-amz-*`, `authorization`, `host`) are never overridden.
 */
function addCustomHeaders(client: BedrockRuntimeClient, headers: Record<string, string>): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string> } | undefined;
      if (request?.headers) {
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (!lower.startsWith("x-amz-") && lower !== "authorization" && lower !== "host") {
            request.headers[key] = value;
          }
        }
      }
      return next(args);
    },
    { step: "build", name: "genericAiCustomHeaders", priority: "low" },
  );
}

/** Report the raw HTTP status and headers, which `$metadata` would otherwise drop. */
function addResponseObserver(
  client: BedrockRuntimeClient,
  onResponse: NonNullable<StreamOptions["onResponse"]>,
  model: Model,
): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response as
        | { statusCode?: unknown; headers?: Record<string, string> }
        | undefined;
      if (typeof response?.statusCode === "number") {
        await onResponse(
          { status: response.statusCode, headers: new Headers(response.headers ?? {}) },
          model,
        );
      }
      return result;
    },
    { step: "deserialize", name: "genericAiResponseObserver" },
  );
}

// ---------------------------------------------------------------------------
// Request conversion
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
  // Lone surrogates make the request body invalid UTF-8.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

function nonBlankText(text: string): ContentBlock.TextMember | undefined {
  const sanitized = sanitize(text);
  return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(chunks: readonly Uint8Array[]): string {
  // Encrypted reasoning runs to tens of KB: build the binary string in slices.
  const window = 0x8000;
  let binary = "";
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += window) {
      binary += String.fromCharCode(...chunk.subarray(index, index + window));
    }
  }
  return btoa(binary);
}

const IMAGE_FORMATS: Record<string, "jpeg" | "png" | "gif" | "webp"> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function imageBlock(image: ImageContent): ContentBlock.ImageMember {
  const format = IMAGE_FORMATS[image.mimeType];
  if (!format) {
    throw new Error(`Unknown image type: ${image.mimeType}`);
  }
  return { image: { format, source: { bytes: base64ToBytes(image.data) } } };
}

/** Bedrock documents reject empty keys. */
function document(value: JsonValue): never {
  const clean = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) {
      return input.map(clean);
    }
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([key]) => key.length > 0)
          .map(([key, nested]) => [key, clean(nested)]),
      );
    }
    return input;
  };
  return clean(value) as never;
}

function toolResultContent(
  content: readonly (TextContent | ImageContent)[],
): ToolResultContentBlock[] {
  const result: ToolResultContentBlock[] = [];
  for (const block of content) {
    if (block.type === "image") {
      result.push({ image: imageBlock(block).image });
    } else {
      const text = nonBlankText(block.text);
      if (text) {
        result.push(text);
      }
    }
  }
  return result.length > 0 ? result : [{ text: EMPTY_TEXT_PLACEHOLDER }];
}

/** Claude rejects images in error tool results: replace them and send them after the results. */
function splitErrorImages(message: ToolResultMessage) {
  if (!message.isError) {
    return undefined;
  }
  const images = message.content.filter((block): block is ImageContent => block.type === "image");
  if (images.length === 0) {
    return undefined;
  }
  const content: TextContent[] = [];
  let previousPlaceholder = false;
  for (const block of message.content) {
    if (block.type === "image") {
      if (!previousPlaceholder) {
        content.push({ type: "text", text: ERROR_TOOL_IMAGE_PLACEHOLDER });
      }
      previousPlaceholder = true;
    } else {
      content.push(block);
      previousPlaceholder = block.text === ERROR_TOOL_IMAGE_PLACEHOLDER;
    }
  }
  return {
    content,
    caption: `Images from the error result of tool call ${message.toolCallId} (${message.toolName}):`,
    images,
  };
}

function cachePoint(retention: CacheRetention): ContentBlock.CachePointMember {
  return {
    cachePoint: { type: "default", ...(retention === "long" ? { ttl: "1h" as never } : {}) },
  };
}

/** Convert a transcript to Bedrock Converse messages. */
export function convertBedrockMessages(
  model: Model,
  messages: Context["messages"],
  cacheRetention: CacheRetention = "short",
  env: Env = process.env,
): BedrockMessage[] {
  const claude = isBedrockClaude(model);
  const normalize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const transformed = transformMessages(messages, model, normalize);
  const result: BedrockMessage[] = [];
  for (let index = 0; index < transformed.length; index += 1) {
    const message = transformed[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      const content: ContentBlock[] = [];
      if (typeof message.content === "string") {
        content.push(nonBlankText(message.content) ?? { text: EMPTY_TEXT_PLACEHOLDER });
      } else {
        for (const block of message.content) {
          if (block.type === "text") {
            const text = nonBlankText(block.text);
            if (text) {
              content.push(text);
            }
          } else {
            content.push(imageBlock(block));
          }
        }
        if (content.length === 0) {
          content.push({ text: EMPTY_TEXT_PLACEHOLDER });
        }
      }
      result.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const content: ContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          const text = nonBlankText(block.text);
          if (text) {
            content.push(text);
          }
        } else if (block.type === "toolCall") {
          content.push({
            toolUse: { toolUseId: block.id, name: block.name, input: document(block.arguments) },
          });
        } else if (block.redacted) {
          // Encrypted reasoning is opaque: replay the stored payload verbatim.
          try {
            const redactedContent = block.thinkingSignature
              ? base64ToBytes(block.thinkingSignature)
              : undefined;
            if (redactedContent?.length) {
              content.push({ reasoningContent: { redactedContent } });
            }
          } catch {
            // A signature that is not base64 cannot be replayed; drop the block.
          }
        } else {
          const thinking = sanitize(block.thinking);
          if (thinking.trim().length === 0) {
            continue;
          }
          if (!claude) {
            // Only Claude accepts the signature field.
            content.push({ reasoningContent: { reasoningText: { text: thinking } } });
          } else if (block.thinkingSignature?.trim()) {
            content.push({
              reasoningContent: {
                reasoningText: { text: thinking, signature: block.thinkingSignature },
              },
            });
          } else {
            // Unsigned thinking (a partial or foreign message) is rejected as reasoning: send text.
            content.push({ text: thinking });
          }
        }
      }
      if (content.length > 0) {
        result.push({ role: "assistant", content });
      }
      continue;
    }
    // Bedrock needs every tool result of a turn in one user message.
    const results: ContentBlock[] = [];
    const errorImages: ContentBlock[] = [];
    let cursor = index;
    while (transformed[cursor]?.role === "toolResult") {
      const toolResult = transformed[cursor] as ToolResultMessage;
      const split = claude ? splitErrorImages(toolResult) : undefined;
      results.push({
        toolResult: {
          toolUseId: toolResult.toolCallId,
          content: toolResultContent(split?.content ?? toolResult.content),
          status: toolResult.isError ? "error" : "success",
        },
      });
      if (split) {
        errorImages.push({ text: split.caption }, ...split.images.map(imageBlock));
      }
      cursor += 1;
    }
    index = cursor - 1;
    result.push({ role: "user", content: [...results, ...errorImages] });
  }
  const last = result.at(-1);
  if (
    cacheRetention !== "none" &&
    bedrockSupportsPromptCaching(model, env) &&
    last?.role === "user"
  ) {
    last.content?.push(cachePoint(cacheRetention));
  }
  return result;
}

function convertTools(
  tools: readonly Tool[] | undefined,
  choice: ToolChoice | undefined,
): ConverseStreamCommandInput["toolConfig"] {
  if (!tools?.length || choice === "none") {
    return undefined;
  }
  const specs: BedrockTool[] = tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: document(tool.parameters as JsonValue) },
    },
  }));
  const toolChoice =
    choice === undefined || choice === "auto"
      ? choice === "auto"
        ? { auto: {} }
        : undefined
      : choice === "required"
        ? { any: {} }
        : { tool: { name: choice.name } };
  return { tools: specs, ...(toolChoice ? { toolChoice } : {}) };
}

/** Model-specific request fields: Claude thinking, OpenAI reasoning effort, flat `reasoning_effort`. */
export function bedrockAdditionalFields(
  model: Model,
  options: StreamOptions | undefined,
  env: Env = process.env,
): Record<string, unknown> | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  const level = options?.reasoning;
  const claude = isBedrockClaude(model);
  const gpt = matchesAny(model, ["gpt-"]);
  if (!claude && !gpt) {
    // Other families (Kimi, GLM) take a flat reasoning_effort, which Converse forwards unchecked:
    // send only values the model's map lists, including "off" (some models otherwise reason at max).
    const effort = model.thinkingLevelMap?.[level ?? "off"];
    return typeof effort === "string" ? { reasoning_effort: effort } : undefined;
  }
  if (!level) {
    return undefined;
  }
  if (claude) {
    // GovCloud rejects `thinking.display` and block binding.
    const govCloud = isGovCloud(model, env);
    const display = govCloud ? {} : { display: "summarized" };
    if (bedrockUsesAdaptiveThinking(model)) {
      // Signed thinking is bound to the system prompt and tools it was made with; drop stale blocks
      // on replay instead of failing (Claude 4.7+, as on the Anthropic API).
      const binding = !govCloud && matchesAny(model, NATIVE_XHIGH);
      const mapped = model.thinkingLevelMap?.[level];
      const effort =
        level === "xhigh" && matchesAny(model, NATIVE_XHIGH)
          ? "xhigh"
          : typeof mapped === "string"
            ? mapped
            : level === "minimal" || level === "low"
              ? "low"
              : level === "xhigh"
                ? "high"
                : level;
      return {
        thinking: {
          type: "adaptive",
          ...display,
          ...(binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
        },
        output_config: { effort },
        ...(binding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
      };
    }
    const budget = options?.thinkingBudgets?.[level] ?? BUDGETS[level];
    return {
      thinking: { type: "enabled", budget_tokens: budget, ...display },
      anthropic_beta: [INTERLEAVED_THINKING_BETA],
    };
  }
  if (matchesAny(model, ["gpt-oss"])) {
    return { reasoning_effort: OPENAI_GPT_OSS_EFFORT[level] };
  }
  const mapped = model.thinkingLevelMap?.[level];
  return { reasoning: { effort: typeof mapped === "string" ? mapped : OPENAI_GPT_EFFORT[level] } };
}

/** Build the ConverseStream command input for a context. */
export function buildBedrockCommandInput(
  model: Model,
  context: Context,
  options?: StreamOptions,
  env: Env = process.env,
): ConverseStreamCommandInput {
  const retention = options?.cacheRetention ?? "short";
  const caching = retention !== "none" && bedrockSupportsPromptCaching(model, env);
  const system: SystemContentBlock[] | undefined = context.systemPrompt
    ? [
        { text: sanitize(context.systemPrompt) },
        ...(caching ? [cachePoint(retention) as SystemContentBlock] : []),
      ]
    : undefined;
  const claude = isBedrockClaude(model);
  let maxTokens = options?.maxTokens ?? (claude ? model.maxTokens : undefined);
  const additional = bedrockAdditionalFields(model, options, env);
  const thinking = additional?.["thinking"] as { budget_tokens?: number } | undefined;
  if (thinking?.budget_tokens !== undefined) {
    // The budget must stay below maxTokens; leave room for the visible answer.
    maxTokens = Math.max(maxTokens ?? 0, thinking.budget_tokens + 4096);
  }
  const toolConfig = convertTools(context.tools, options?.toolChoice);
  return {
    modelId: model.id,
    messages: convertBedrockMessages(model, context.messages, retention, env),
    ...(system ? { system } : {}),
    inferenceConfig: {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    },
    ...(toolConfig ? { toolConfig } : {}),
    ...(additional ? { additionalModelRequestFields: additional as never } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

/** Map a Bedrock stop reason; unknown reasons are provider error stops. */
export function mapBedrockStopReason(reason: string | undefined): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    default:
      return reason
        ? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
        : { stopReason: "error" };
  }
}

interface OpenBlock {
  readonly contentIndex: number;
  json?: string;
  redactedChunks?: Uint8Array[];
}

/** Translate ConverseStream events into the runtime's assistant event protocol. */
export async function consumeBedrockStream(
  events: AsyncIterable<ConverseStreamOutput>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  output.stopReason = "pending";
  const open = new Map<number, OpenBlock>();
  let started = false;
  const start = () => {
    if (!started) {
      started = true;
      stream.push({ type: "start", partial: output });
    }
  };
  const flushRedacted = (state: OpenBlock) => {
    const block = output.content[state.contentIndex];
    if (block?.type === "thinking" && state.redactedChunks) {
      // Kept off the block while streaming: bytes are not JSON.
      block.thinkingSignature = bytesToBase64(state.redactedChunks);
      delete state.redactedChunks;
    }
  };
  const stop = (blockIndex: number) => {
    const state = open.get(blockIndex);
    if (!state) {
      return;
    }
    open.delete(blockIndex);
    const contentIndex = state.contentIndex;
    const block = output.content[contentIndex];
    if (block?.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block?.type === "thinking") {
      flushRedacted(state);
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
    } else if (block?.type === "toolCall") {
      const parsed = parseToolCallArguments(state.json ?? "");
      block.arguments = parsed.arguments;
      if (parsed.argumentsError !== undefined) {
        block.argumentsError = parsed.argumentsError;
      }
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    }
  };

  try {
    for await (const event of events) {
      if (event.messageStart) {
        if (event.messageStart.role !== "assistant") {
          throw new Error("Unexpected message start for a non-assistant role");
        }
        start();
      } else if (event.contentBlockStart) {
        start();
        const toolUse = event.contentBlockStart.start?.toolUse;
        if (toolUse) {
          output.content.push({
            type: "toolCall",
            id: toolUse.toolUseId ?? "",
            name: toolUse.name ?? "",
            arguments: {},
          });
          const contentIndex = output.content.length - 1;
          open.set(event.contentBlockStart.contentBlockIndex ?? 0, { contentIndex, json: "" });
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
      } else if (event.contentBlockDelta) {
        start();
        const blockIndex = event.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = event.contentBlockDelta.delta;
        let state = open.get(blockIndex);
        if (delta?.text !== undefined) {
          // Text blocks get no contentBlockStart.
          if (!state) {
            output.content.push({ type: "text", text: "" });
            state = { contentIndex: output.content.length - 1 };
            open.set(blockIndex, state);
            stream.push({ type: "text_start", contentIndex: state.contentIndex, partial: output });
          }
          const block = output.content[state.contentIndex];
          if (block?.type === "text") {
            block.text += delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: state.contentIndex,
              delta: delta.text,
              partial: output,
            });
          }
        } else if (delta?.toolUse && state?.json !== undefined) {
          const block = output.content[state.contentIndex];
          const input = delta.toolUse.input ?? "";
          state.json += input;
          if (block?.type === "toolCall") {
            block.arguments = parseStreamingJson(state.json);
          }
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.contentIndex,
            delta: input,
            partial: output,
          });
        } else if (delta?.reasoningContent) {
          if (!state) {
            output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
            state = { contentIndex: output.content.length - 1 };
            open.set(blockIndex, state);
            stream.push({
              type: "thinking_start",
              contentIndex: state.contentIndex,
              partial: output,
            });
          }
          const block = output.content[state.contentIndex];
          if (block?.type !== "thinking") {
            continue;
          }
          const reasoning = delta.reasoningContent;
          if (reasoning.text) {
            block.thinking += reasoning.text;
            stream.push({
              type: "thinking_delta",
              contentIndex: state.contentIndex,
              delta: reasoning.text,
              partial: output,
            });
          }
          // A block holds either a Claude signature or an opaque redacted payload, never both.
          if (reasoning.signature && !block.redacted) {
            block.thinkingSignature = (block.thinkingSignature ?? "") + reasoning.signature;
          }
          if (reasoning.redactedContent?.length) {
            if (!block.redacted) {
              block.redacted = true;
              block.thinkingSignature = "";
              block.thinking += REDACTED_THINKING_PLACEHOLDER;
              stream.push({
                type: "thinking_delta",
                contentIndex: state.contentIndex,
                delta: REDACTED_THINKING_PLACEHOLDER,
                partial: output,
              });
            }
            state.redactedChunks ??= [];
            state.redactedChunks.push(reasoning.redactedContent);
          }
        }
      } else if (event.contentBlockStop) {
        stop(event.contentBlockStop.contentBlockIndex ?? 0);
      } else if (event.messageStop) {
        if (event.messageStop.stopReason !== undefined) {
          output.rawStopReason = event.messageStop.stopReason;
        }
        const mapped = mapBedrockStopReason(event.messageStop.stopReason);
        output.stopReason = mapped.stopReason;
        if (mapped.errorMessage) {
          output.errorMessage = mapped.errorMessage;
        }
      } else if (event.metadata?.usage) {
        const usage = event.metadata.usage;
        output.usage.input = usage.inputTokens ?? 0;
        output.usage.output = usage.outputTokens ?? 0;
        output.usage.cacheRead = usage.cacheReadInputTokens ?? 0;
        output.usage.cacheWrite = usage.cacheWriteInputTokens ?? 0;
        output.usage.totalTokens = usage.totalTokens ?? output.usage.input + output.usage.output;
      } else {
        const failure =
          event.internalServerException ??
          event.modelStreamErrorException ??
          event.validationException ??
          event.throttlingException ??
          event.serviceUnavailableException;
        if (failure) {
          throw failure;
        }
      }
    }
  } finally {
    // A stream can settle without stopping every block.
    for (const state of open.values()) {
      flushRedacted(state);
    }
  }
  for (const blockIndex of [...open.keys()]) {
    stop(blockIndex);
  }
  if (output.stopReason === "pending") {
    throw new Error("Bedrock stream ended without a stop reason");
  }
  calculateCost(model, output.usage);
}

/**
 * Format a Bedrock error with a stable prefix per exception (retry and overflow detection match on
 * these), and point at the docs when a model rejects the account's data retention mode.
 */
export function formatBedrockError(error: unknown): string {
  const named = error as { name?: unknown; message?: unknown } | undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof named?.message === "string"
        ? named.message
        : String(error);
  const hint = /data retention mode/i.test(message)
    ? ` See ${DATA_RETENTION_DOCS_URL} for supported data retention modes.`
    : "";
  const name = typeof named?.name === "string" ? named.name : undefined;
  const prefix =
    error instanceof BedrockRuntimeServiceException ||
    (name !== undefined && ERROR_PREFIXES[name] !== undefined)
      ? (ERROR_PREFIXES[name ?? ""] ?? name)
      : undefined;
  return prefix ? `${prefix}: ${message}${hint}` : `${message}${hint}`;
}

/** Stream a response from Amazon Bedrock (`api: "bedrock-converse-stream"`). */
export function streamBedrock(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const client = new BedrockRuntimeClient(resolveBedrockClientConfig(model, options));
    if (options?.onResponse) {
      addResponseObserver(client, options.onResponse, model);
    }
    const headers = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
    if (Object.keys(headers).length > 0) {
      addCustomHeaders(client, headers);
    }
    const input = (await applyPayloadHook(
      buildBedrockCommandInput(model, context, options),
      model,
      options,
    )) as ConverseStreamCommandInput;
    try {
      const response = await client.send(new ConverseStreamCommand(input), {
        ...(options?.signal ? { abortSignal: options.signal } : {}),
      });
      if (!response.stream) {
        throw new Error("Bedrock response has no stream");
      }
      await consumeBedrockStream(response.stream, model, output, stream);
    } catch (error) {
      if (options?.signal?.aborted) {
        throw error;
      }
      throw new Error(formatBedrockError(error));
    } finally {
      client.destroy();
    }
  });
}
