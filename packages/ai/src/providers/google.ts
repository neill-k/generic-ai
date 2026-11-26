import {
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type HttpOptions,
  type Part,
  type ThinkingConfig,
} from "@google/genai";

import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, mergeHeaders, runProviderStream } from "../http.js";
import { transformMessages } from "../transform-messages.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
} from "../types.js";
import { calculateCost } from "../usage.js";
import { resolveApiKey } from "./env.js";

/**
 * Google Gemini (`google-generative-ai`, API key) and Vertex AI (`google-vertex`, API key or
 * application default credentials with a project and location), built on `@google/genai`.
 * Adapted from pi's `google-generative-ai.ts`, `google-vertex.ts` and `google-shared.ts`
 * (badlogic/pi-mono, MIT).
 *
 * Thought signatures are kept on the text, thinking and tool-call parts that carried them and are
 * replayed only to the same model, as Gemini requires.
 */

type GoogleApi = "google-generative-ai" | "google-vertex";

let toolCallCounter = 0;

function geminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/gemini(?:-live)?-(\d+)/);
  return match === null ? undefined : Number.parseInt(match[1] as string, 10);
}

/** Gemini 3+ and Gemma 4 take a discrete `thinkingLevel`; older models a token `thinkingBudget`. */
export function usesGoogleThinkingLevel(model: Model): boolean {
  const id = model.id.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
    (geminiMajorVersion(id) ?? 0) >= 4 ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest" ||
    /gemma-?4/.test(id)
  );
}

/** Models behind Google APIs that need explicit ids on function calls and responses. */
export function requiresGoogleToolCallId(modelId: string): boolean {
  const major = geminiMajorVersion(modelId);
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    (major !== undefined && major >= 3)
  );
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const major = geminiMajorVersion(modelId);
  return major === undefined || major >= 3;
}

/** Token budget for budget-based Gemini models: custom budgets, then per-model defaults, else dynamic. */
export function getGoogleThinkingBudget(
  model: Model,
  level: ThinkingLevel,
  custom?: StreamOptions["thinkingBudgets"],
): number {
  const capped = level === "xhigh" ? "high" : level;
  const override = custom?.[capped];
  if (override !== undefined) {
    return override;
  }
  const tables: [string, Record<"minimal" | "low" | "medium" | "high", number>][] = [
    ["2.5-pro", { minimal: 128, low: 2048, medium: 8192, high: 32768 }],
    ["2.5-flash-lite", { minimal: 512, low: 2048, medium: 8192, high: 24576 }],
    ["2.5-flash", { minimal: 128, low: 2048, medium: 8192, high: 24576 }],
  ];
  for (const [fragment, budgets] of tables) {
    if (model.id.includes(fragment)) {
      return budgets[capped];
    }
  }
  return -1;
}

function googleThinkingLevel(level: ThinkingLevel): string {
  // The SDK's levels stop at HIGH; xhigh asks for the most it has.
  return level === "xhigh" ? "HIGH" : level.toUpperCase();
}

/** The thinking config: on with a level or budget, or explicitly off for a reasoning model. */
export function googleThinkingConfig(
  model: Model,
  options: StreamOptions | undefined,
): ThinkingConfig | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  const level = options?.reasoning;
  if (level === undefined) {
    return usesGoogleThinkingLevel(model)
      ? ({ thinkingLevel: "MINIMAL" } as ThinkingConfig)
      : { thinkingBudget: 0 };
  }
  return usesGoogleThinkingLevel(model)
    ? ({ includeThoughts: true, thinkingLevel: googleThinkingLevel(level) } as ThinkingConfig)
    : {
        includeThoughts: true,
        thinkingBudget: getGoogleThinkingBudget(model, level, options?.thinkingBudgets),
      };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function validSignature(signature: string | undefined): string | undefined {
  return signature !== undefined && signature.length % 4 === 0 && BASE64.test(signature)
    ? signature
    : undefined;
}

function retainSignature(existing: string | undefined, incoming: string | undefined) {
  return typeof incoming === "string" && incoming.length > 0 ? incoming : existing;
}

function sanitize(text: string): string {
  // Lone surrogates make the request body invalid UTF-8.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

/** Convert a transcript to Gemini contents. */
export function convertGoogleMessages(model: Model, context: Context): Content[] {
  const contents: Content[] = [];
  const includeId = requiresGoogleToolCallId(model.id);
  const normalize = (id: string) =>
    includeId ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id;
  for (const message of transformMessages(context.messages, model, normalize)) {
    if (message.role === "user") {
      const parts: Part[] =
        typeof message.content === "string"
          ? [{ text: sanitize(message.content) }]
          : message.content.map((item) =>
              item.type === "text"
                ? { text: sanitize(item.text) }
                : { inlineData: { mimeType: item.mimeType, data: item.data } },
            );
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
    } else if (message.role === "assistant") {
      const same = message.provider === model.provider && message.model === model.id;
      const parts: Part[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          const signature = same ? validSignature(block.textSignature) : undefined;
          // An empty part that carries a signature must still be echoed back.
          if (block.text.trim() === "" && signature === undefined) {
            continue;
          }
          parts.push({
            text: sanitize(block.text),
            ...(signature === undefined ? {} : { thoughtSignature: signature }),
          });
        } else if (block.type === "thinking") {
          const signature = same ? validSignature(block.thinkingSignature) : undefined;
          if (block.thinking.trim() === "" && signature === undefined) {
            continue;
          }
          parts.push(
            same
              ? {
                  thought: true,
                  text: sanitize(block.thinking),
                  ...(signature === undefined ? {} : { thoughtSignature: signature }),
                }
              : { text: sanitize(block.thinking) },
          );
        } else {
          const signature = same ? validSignature(block.thoughtSignature) : undefined;
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(includeId ? { id: block.id } : {}),
            },
            ...(signature === undefined ? {} : { thoughtSignature: signature }),
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else {
      const text = message.content
        .filter((item): item is TextContent => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const images = model.input.includes("image")
        ? message.content.filter((item): item is ImageContent => item.type === "image")
        : [];
      const hasText = text.trim().length > 0;
      const value = hasText ? sanitize(text) : images.length > 0 ? "(see attached image)" : "";
      const imageParts: Part[] = images.map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.data },
      }));
      const nested = images.length > 0 && supportsMultimodalFunctionResponse(model.id);
      const part: Part = {
        functionResponse: {
          name: message.toolName,
          response: message.isError ? { error: value } : { output: value },
          ...(nested ? { parts: imageParts } : {}),
          ...(includeId ? { id: message.toolCallId } : {}),
        },
      };
      const last = contents.at(-1);
      // All function responses for one model turn go in a single user turn.
      if (last?.role === "user" && last.parts?.some((item) => item.functionResponse) === true) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      if (images.length > 0 && !nested) {
        contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
      }
    }
  }
  return contents;
}

const SCHEMA_META = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);
const NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);
const SUBSCHEMAS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

function stripMeta(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !SCHEMA_META.has(key))
      .map(([key, value]) => [key, stripMeta(value)]),
  );
}

/** Gemini ignores `const` in `parametersJsonSchema` but honors a one-value `enum`. */
function constAsEnum(schema: unknown, isNameMap = false): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => constAsEnum(item));
  }
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (isNameMap || SUBSCHEMAS.has(key)) {
        return [key, constAsEnum(value)];
      }
      if (NAME_MAPS.has(key)) {
        return [key, constAsEnum(value, true)];
      }
      return [key, value];
    }),
  );
  if (!isNameMap && "const" in result && result["enum"] === undefined) {
    const value = result["const"];
    if (typeof value === "string" || typeof value === "number") {
      delete result["const"];
      result["enum"] = [value];
    }
  }
  return result;
}

/**
 * Convert tools to function declarations. `parametersJsonSchema` takes full JSON Schema;
 * `useParameters` sends the legacy OpenAPI `parameters` field instead.
 */
export function convertGoogleTools(
  tools: readonly Tool[],
  useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(useParameters
          ? { parameters: stripMeta(tool.parameters) }
          : { parametersJsonSchema: constAsEnum(tool.parameters) }),
      })),
    },
  ];
}

/** Map a Gemini finish reason. CONTINUATION (a per-request token limit) is a length stop. */
export function mapGoogleStopReason(reason: string): StopReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
    case "CONTINUATION":
      return "length";
    default:
      return "error";
  }
}

function googleToolMode(choice: StreamOptions["toolChoice"]): string | undefined {
  if (choice === undefined || choice === "auto") {
    return choice === "auto" ? "AUTO" : undefined;
  }
  if (choice === "none") {
    return "NONE";
  }
  return "ANY";
}

/** Build the request for a context. */
export function buildGoogleParams(
  model: Model,
  context: Context,
  options?: StreamOptions,
): GenerateContentParameters {
  const tools = context.tools ?? [];
  const mode = tools.length > 0 ? googleToolMode(options?.toolChoice) : undefined;
  const thinkingConfig = googleThinkingConfig(model, options);
  const config: GenerateContentConfig = {
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(context.systemPrompt ? { systemInstruction: sanitize(context.systemPrompt) } : {}),
    ...(tools.length > 0 ? { tools: convertGoogleTools(tools) } : {}),
    ...(mode === undefined
      ? {}
      : {
          toolConfig: {
            functionCallingConfig: {
              mode,
              ...(typeof options?.toolChoice === "object"
                ? { allowedFunctionNames: [options.toolChoice.name] }
                : {}),
            },
          },
        }),
    ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
    ...(options?.signal === undefined ? {} : { abortSignal: options.signal }),
  } as GenerateContentConfig;
  return { model: model.id, contents: convertGoogleMessages(model, context), config };
}

function promptBlockError(
  provider: string,
  feedback: NonNullable<GenerateContentResponse["promptFeedback"]>,
) {
  const details = [`${provider} prompt blocked: ${feedback.blockReason ?? "unknown reason"}`];
  if (feedback.blockReasonMessage) {
    details.push(feedback.blockReasonMessage);
  }
  return details.join(". ");
}

/** Consume a Gemini response stream into `output`, pushing block events. */
export async function consumeGoogleStream(
  chunks: AsyncIterable<GenerateContentResponse>,
  model: Model,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  providerName = "Google",
): Promise<void> {
  output.stopReason = "pending";
  stream.push({ type: "start", partial: output });
  let current: TextContent | ThinkingContent | undefined;
  let received = 0;
  let blocked: string | undefined;
  const index = () => output.content.length - 1;
  const close = () => {
    if (current?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: index(),
        content: current.text,
        partial: output,
      });
    } else if (current?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: index(),
        content: current.thinking,
        partial: output,
      });
    }
    current = undefined;
  };
  for await (const chunk of chunks) {
    received += 1;
    if (chunk.promptFeedback?.blockReason) {
      blocked ??= promptBlockError(providerName, chunk.promptFeedback);
    }
    if (chunk.responseId && output.responseId === undefined) {
      output.responseId = chunk.responseId;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined) {
        const thinking = part.thought === true;
        if (current === undefined || (current.type === "thinking") !== thinking) {
          close();
          current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
          output.content.push(current);
          stream.push({
            type: thinking ? "thinking_start" : "text_start",
            contentIndex: index(),
            partial: output,
          });
        }
        if (current.type === "thinking") {
          current.thinking += part.text;
          const signature = retainSignature(current.thinkingSignature, part.thoughtSignature);
          if (signature !== undefined) {
            current.thinkingSignature = signature;
          }
          stream.push({
            type: "thinking_delta",
            contentIndex: index(),
            delta: part.text,
            partial: output,
          });
        } else {
          current.text += part.text;
          const signature = retainSignature(current.textSignature, part.thoughtSignature);
          if (signature !== undefined) {
            current.textSignature = signature;
          }
          stream.push({
            type: "text_delta",
            contentIndex: index(),
            delta: part.text,
            partial: output,
          });
        }
      }
      if (part.functionCall) {
        close();
        const provided = part.functionCall.id;
        const duplicate =
          provided !== undefined &&
          output.content.some((block) => block.type === "toolCall" && block.id === provided);
        const name = part.functionCall.name ?? "";
        const toolCall: ToolCall = {
          type: "toolCall",
          id:
            provided === undefined || provided === "" || duplicate
              ? `${name}_${Date.now()}_${++toolCallCounter}`
              : provided,
          name,
          arguments: (part.functionCall.args as JsonObject | undefined) ?? {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index(), partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: index(),
          delta: JSON.stringify(toolCall.arguments),
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
      }
    }
    if (candidate?.finishReason) {
      output.rawStopReason = candidate.finishReason;
      output.stopReason = mapGoogleStopReason(candidate.finishReason);
      if (
        output.stopReason === "stop" &&
        output.content.some((block) => block.type === "toolCall")
      ) {
        output.stopReason = "toolUse";
      }
    }
    const usage = chunk.usageMetadata;
    if (usage) {
      const cached = usage.cachedContentTokenCount ?? 0;
      const thoughts = usage.thoughtsTokenCount ?? 0;
      output.usage = {
        input: (usage.promptTokenCount ?? 0) - cached,
        output: (usage.candidatesTokenCount ?? 0) + thoughts,
        cacheRead: cached,
        cacheWrite: 0,
        ...(thoughts > 0 ? { reasoning: thoughts } : {}),
        totalTokens: usage.totalTokenCount ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      calculateCost(model, output.usage);
    }
  }
  close();
  if (output.stopReason === "pending") {
    if (blocked !== undefined) {
      throw new Error(blocked);
    }
    throw new Error(
      `${providerName} stream ended without a finish reason after receiving ${received} ${received === 1 ? "chunk" : "chunks"}`,
    );
  }
  if (output.stopReason === "error") {
    output.errorMessage = output.rawStopReason
      ? `Provider stopped with: ${output.rawStopReason}`
      : "An unknown error occurred";
  }
}

function httpOptions(
  model: Model,
  options: StreamOptions | undefined,
  keepVersion: boolean,
): HttpOptions {
  const result: HttpOptions = {
    // Always pass fetch, so the SDK does not install its own dispatcher without timeouts.
    fetch: options?.fetch ?? globalThis.fetch,
    headers: mergeHeaders({}, model, options),
  } as HttpOptions;
  const baseUrl = model.baseUrl.trim();
  if (baseUrl.length > 0 && !baseUrl.includes("{location}")) {
    result.baseUrl = baseUrl;
    if (!keepVersion || /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(new URL(baseUrl).pathname)) {
      result.apiVersion = "";
    }
  }
  return result;
}

export function createGoogleClient(model: Model, options: StreamOptions | undefined): GoogleGenAI {
  const apiKey = resolveApiKey(model.provider, options?.apiKey);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${model.provider}". Pass apiKey or set GEMINI_API_KEY or GOOGLE_API_KEY.`,
    );
  }
  return new GoogleGenAI({ apiKey, httpOptions: httpOptions(model, options, false) });
}

/** A Vertex client: an API key when one is set, else application default credentials. */
export function createGoogleVertexClient(
  model: Model,
  options: StreamOptions | undefined,
): GoogleGenAI {
  const apiKey = resolveApiKey(model.provider, options?.apiKey);
  const common = {
    vertexai: true,
    apiVersion: "v1",
    httpOptions: httpOptions(model, options, true),
  };
  if (apiKey) {
    return new GoogleGenAI({ ...common, apiKey });
  }
  const project = process.env["GOOGLE_CLOUD_PROJECT"] ?? process.env["GCLOUD_PROJECT"];
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT, or pass an API key.",
    );
  }
  const location = process.env["GOOGLE_CLOUD_LOCATION"];
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION, or pass an API key.",
    );
  }
  const keyFilename = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  return new GoogleGenAI({
    ...common,
    project,
    location,
    ...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
  });
}

function streamWith(
  createClient: (model: Model, options: StreamOptions | undefined) => GoogleGenAI,
  providerName: string,
) {
  return (model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream =>
    runProviderStream(model, options, async (output, stream) => {
      const client = createClient(model, options);
      const params = (await applyPayloadHook(
        buildGoogleParams(model, context, options),
        model,
        options,
      )) as GenerateContentParameters;
      const chunks = await client.models.generateContentStream(params);
      await consumeGoogleStream(chunks, model, output, stream, providerName);
    });
}

export const streamGoogle = streamWith(createGoogleClient, "Google");
export const streamGoogleVertex = streamWith(createGoogleVertexClient, "Google Vertex");

export type { GoogleApi };
