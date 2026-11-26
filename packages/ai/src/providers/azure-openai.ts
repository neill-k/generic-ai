import { AzureOpenAI } from "openai";
import type OpenAI from "openai";

import type { AssistantMessageEventStream } from "../event-stream.js";
import { applyPayloadHook, mergeHeaders, runProviderStream } from "../http.js";
import type { Context, Model, StreamOptions } from "../types.js";
import { resolveApiKey } from "./env.js";
import { buildOpenAIResponsesPayload, consumeOpenAIResponsesEvents } from "./openai-responses.js";

/**
 * Azure OpenAI through the Responses API (`azure-openai-responses`). Adapted from pi's
 * `azure-openai-config.ts` and `azure-openai-responses.ts` (badlogic/pi-mono, MIT).
 *
 * Each user has their own resource, so the endpoint comes from `AZURE_OPENAI_BASE_URL`,
 * `AZURE_OPENAI_RESOURCE_NAME` or the model's `baseUrl`. The model id is sent as the deployment name
 * unless `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`model=deployment,...`) maps it.
 */

const DEFAULT_AZURE_API_VERSION = "v1";

function parseDeploymentMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? "").split(",")) {
    const [modelId, deployment] = entry.trim().split("=", 2);
    if (modelId && deployment) {
      map.set(modelId.trim(), deployment.trim());
    }
  }
  return map;
}

export function resolveAzureDeploymentName(model: Pick<Model, "id">): string {
  return (
    parseDeploymentMap(process.env["AZURE_OPENAI_DEPLOYMENT_NAME_MAP"]).get(model.id) ?? model.id
  );
}

/** Azure hosts get `/openai/v1` as their base path, so the SDK can append the request path. */
export function normalizeAzureBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim().replace(/\/+$/, ""));
  } catch {
    throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
  }
  const azureHost =
    url.hostname.endsWith(".openai.azure.com") ||
    url.hostname.endsWith(".cognitiveservices.azure.com") ||
    url.hostname.endsWith(".ai.azure.com");
  const path = url.pathname.replace(/\/+$/, "");
  if (azureHost && ["", "/", "/openai", "/openai/v1/responses"].includes(path)) {
    url.pathname = "/openai/v1";
    url.search = "";
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolveAzureConfig(model: Pick<Model, "baseUrl">): {
  baseUrl: string;
  apiVersion: string;
} {
  const explicit = process.env["AZURE_OPENAI_BASE_URL"]?.trim();
  const resource = process.env["AZURE_OPENAI_RESOURCE_NAME"]?.trim();
  const baseUrl =
    (explicit || undefined) ??
    (resource ? `https://${resource}.openai.azure.com/openai/v1` : undefined) ??
    (model.baseUrl.trim() || undefined);
  if (baseUrl === undefined) {
    throw new Error(
      "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or set the model's baseUrl.",
    );
  }
  return {
    baseUrl: normalizeAzureBaseUrl(baseUrl),
    apiVersion: process.env["AZURE_OPENAI_API_VERSION"]?.trim() || DEFAULT_AZURE_API_VERSION,
  };
}

export function createAzureOpenAIClient(
  model: Model,
  options: StreamOptions | undefined,
): AzureOpenAI {
  const apiKey = resolveApiKey(model.provider, options?.apiKey);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${model.provider}". Pass apiKey or set AZURE_OPENAI_API_KEY.`,
    );
  }
  const { baseUrl, apiVersion } = resolveAzureConfig(model);
  return new AzureOpenAI({
    apiKey,
    apiVersion,
    baseURL: baseUrl,
    defaultHeaders: mergeHeaders({}, model, options),
    maxRetries: options?.maxRetries ?? 2,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });
}

export function streamAzureOpenAIResponses(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return runProviderStream(model, options, async (output, stream) => {
    const client = createAzureOpenAIClient(model, options);
    const payload = await applyPayloadHook(
      {
        ...buildOpenAIResponsesPayload(model, context, options),
        model: resolveAzureDeploymentName(model),
      },
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
