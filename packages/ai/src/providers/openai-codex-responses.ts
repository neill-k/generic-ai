import OpenAI from "openai";
import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, mergeHeaders, runProviderStream } from "../http.js";
import type { Context, Model, StreamOptions } from "../types.js";
import { resolveApiKey } from "./env.js";
import { buildOpenAIResponsesPayload, consumeOpenAIResponsesEvents } from "./openai-responses.js";

/**
 * ChatGPT Plus/Pro through the Codex backend (`openai-codex-responses`). Adapted from pi's
 * `openai-codex-responses.ts` (badlogic/pi-mono, MIT), server-sent events transport only.
 *
 * The backend speaks the Responses API at `<baseUrl>/codex/responses`, authenticated with the
 * ChatGPT access token from `openaiCodexOAuth` in `@generic-ai/auth`. Requests are stateless
 * (`store: false`) with encrypted reasoning replayed, the system prompt goes in a leading developer
 * item (top-level instructions defeat prompt caching across turns), and every request carries the
 * account id from the token, `OpenAI-Beta: responses=experimental` and an `originator`.
 */

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** The SDK appends `/responses`, so the client's base URL ends in `/codex`. */
export function resolveCodexClientBaseUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
  if (normalized.endsWith("/codex")) return normalized;
  return `${normalized}/codex`;
}

/** The ChatGPT account id carried in the access token, or undefined if it cannot be read. */
export function extractCodexAccountId(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claims = payload[JWT_CLAIM_PATH];
    if (!claims || typeof claims !== "object") return undefined;
    const id = (claims as Record<string, unknown>)["chatgpt_account_id"];
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Build the Codex request body: the Responses payload with the system prompt as a developer item. */
export function buildOpenAICodexPayload(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Record<string, unknown> {
  const { systemPrompt: _systemPrompt, ...rest } = context;
  const payload = buildOpenAIResponsesPayload(model, rest, options);
  const input = Array.isArray(payload["input"]) ? (payload["input"] as unknown[]) : [];
  if (context.systemPrompt) {
    payload["input"] = [
      { role: "developer", content: [{ type: "input_text", text: context.systemPrompt }] },
      ...input,
    ];
  }
  delete payload["prompt_cache_retention"];
  payload["store"] = false;
  payload["include"] = ["reasoning.encrypted_content"];
  payload["tool_choice"] ??= "auto";
  payload["parallel_tool_calls"] = true;
  payload["text"] = { verbosity: "low" };
  return payload;
}

function createCodexClient(model: Model, options: StreamOptions | undefined): OpenAI {
  const token = resolveApiKey(model.provider, options?.apiKey);
  if (!token) {
    throw new Error(
      `No ChatGPT sign-in for provider "${model.provider}". Sign in with openaiCodexOAuth from @generic-ai/auth and pass the access token as apiKey.`,
    );
  }
  const headers = mergeHeaders(
    { "OpenAI-Beta": "responses=experimental", originator: "generic-ai" },
    model,
    options,
  );
  const hasAccountHeader = Object.keys(headers).some(
    (name) => name.toLowerCase() === "chatgpt-account-id",
  );
  if (!hasAccountHeader) {
    const accountId = extractCodexAccountId(token);
    if (!accountId) {
      throw new Error("Could not read the ChatGPT account id from the access token.");
    }
    headers["chatgpt-account-id"] = accountId;
  }
  if (options?.sessionId) {
    headers["session-id"] ??= options.sessionId;
  }
  return new OpenAI({
    apiKey: token,
    baseURL: resolveCodexClientBaseUrl(model.baseUrl),
    defaultHeaders: headers,
    maxRetries: options?.maxRetries ?? 2,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}

export function streamOpenAICodexResponses(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const client = createCodexClient(model, options);
    const payload = await applyPayloadHook(
      buildOpenAICodexPayload(model, context, options),
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
