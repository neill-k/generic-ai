// Google Gemini, Vertex and Azure OpenAI provider tests, driven through the official SDKs with a
// recording `fetch`. Cases ported from pi's `google-*` and `azure-*` suites and
// `clamp-max-tokens.test.ts` (badlogic/pi-mono, MIT).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AssistantMessage,
  buildGoogleParams,
  clampMaxTokensToContext,
  type Context,
  complete,
  convertGoogleMessages,
  convertGoogleTools,
  getGoogleThinkingBudget,
  mapGoogleStopReason,
  type Model,
  normalizeAzureBaseUrl,
  resolveAzureConfig,
  resolveAzureDeploymentName,
  resolveModel,
  usesGoogleThinkingLevel,
} from "../src/index.js";

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function sse(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

function replay(body: string, record: Recorded[] = [], status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    record.push({
      url,
      headers,
      body: raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {},
    });
    return new Response(body, {
      status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
    });
  }) as typeof fetch;
}

const tool = {
  name: "lookup",
  description: "Look something up",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { query: { type: "string" }, mode: { const: "fast" } },
    required: ["query"],
  },
};

const usage = {
  promptTokenCount: 120,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 10,
  cachedContentTokenCount: 20,
  totalTokenCount: 160,
};

function gemini(id = "gemini-3-pro-preview"): Model {
  return resolveModel(`google/${id}`, {
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  });
}

function assistant(model: Model, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

const SIG = "c2lnbmF0dXJl"; // valid base64

describe("Google Gemini provider", () => {
  it("streams thinking, text and a function call with its thought signature", async () => {
    const model = gemini();
    const recorded: Recorded[] = [];
    const body = sse([
      {
        responseId: "resp-1",
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Planning", thought: true, thoughtSignature: SIG }],
            },
          },
        ],
      },
      { candidates: [{ content: { role: "model", parts: [{ text: "Looking it up." }] } }] },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { id: "call-1", name: "lookup", args: { query: "x" } },
                  thoughtSignature: SIG,
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: usage,
      },
    ]);
    const message = await complete(
      model,
      {
        systemPrompt: "Be brief.",
        messages: [{ role: "user", content: "find x", timestamp: 1 }],
        tools: [tool],
      },
      { apiKey: "test-key", reasoning: "high", fetch: replay(body, recorded) },
    );
    expect(message.stopReason).toBe("toolUse");
    expect(message.responseId).toBe("resp-1");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Planning", thinkingSignature: SIG },
      { type: "text", text: "Looking it up." },
      {
        type: "toolCall",
        id: "call-1",
        name: "lookup",
        arguments: { query: "x" },
        thoughtSignature: SIG,
      },
    ]);
    expect(message.usage).toMatchObject({
      input: 100,
      output: 40,
      cacheRead: 20,
      reasoning: 10,
      totalTokens: 160,
    });
    expect(message.usage.cost.total).toBeCloseTo((100 * 1 + 40 * 2 + 20 * 0.5) / 1e6);
    const request = recorded[0] as Recorded;
    expect(request.url).toContain("/v1beta/models/gemini-3-pro-preview:streamGenerateContent");
    expect(request.headers.get("x-goog-api-key")).toBe("test-key");
    expect(request.body["systemInstruction"]).toMatchObject({ parts: [{ text: "Be brief." }] });
    expect(request.body["generationConfig"]).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    });
  });

  it("maps finish reasons and reports error stops and missing finish reasons", async () => {
    expect(mapGoogleStopReason("STOP")).toBe("stop");
    expect(mapGoogleStopReason("MAX_TOKENS")).toBe("length");
    expect(mapGoogleStopReason("CONTINUATION")).toBe("length");
    expect(mapGoogleStopReason("MALFORMED_FUNCTION_CALL")).toBe("error");
    const model = gemini();
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    const malformed = await complete(model, context, {
      apiKey: "k",
      fetch: replay(
        sse([{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: usage }]),
      ),
    });
    expect(malformed.stopReason).toBe("error");
    expect(malformed.rawStopReason).toBe("MALFORMED_FUNCTION_CALL");
    expect(malformed.errorMessage).toBe("Provider stopped with: MALFORMED_FUNCTION_CALL");
    const unfinished = await complete(model, context, {
      apiKey: "k",
      fetch: replay(
        sse([{ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] }]),
      ),
    });
    expect(unfinished.errorMessage).toBe(
      "Google stream ended without a finish reason after receiving 1 chunk",
    );
    const blocked = await complete(model, context, {
      apiKey: "k",
      fetch: replay(
        sse([{ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Unsafe" } }]),
      ),
    });
    expect(blocked.errorMessage).toBe("Google prompt blocked: SAFETY. Unsafe");
    const http = await complete(model, context, {
      apiKey: "k",
      maxRetries: 0,
      fetch: replay(JSON.stringify({ error: { code: 400, message: "bad request" } }), [], 400),
    });
    expect(http.stopReason).toBe("error");
    expect(http.errorMessage).toContain("bad request");
  });

  it("requires an API key", async () => {
    const saved = { gemini: process.env["GEMINI_API_KEY"], google: process.env["GOOGLE_API_KEY"] };
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    try {
      const message = await complete(gemini(), {
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      });
      expect(message.errorMessage).toContain('No API key for provider "google"');
    } finally {
      if (saved.gemini !== undefined) process.env["GEMINI_API_KEY"] = saved.gemini;
      if (saved.google !== undefined) process.env["GOOGLE_API_KEY"] = saved.google;
    }
  });

  it("chooses thinking levels, budgets, and explicit off", () => {
    expect(usesGoogleThinkingLevel(gemini("gemini-3-flash-preview"))).toBe(true);
    expect(usesGoogleThinkingLevel(gemini("gemini-3.1-pro-preview"))).toBe(true);
    expect(usesGoogleThinkingLevel(gemini("gemini-4-argon"))).toBe(true);
    expect(usesGoogleThinkingLevel(gemini("gemini-2.5-pro"))).toBe(false);
    expect(getGoogleThinkingBudget(gemini("gemini-2.5-pro"), "medium")).toBe(8192);
    expect(getGoogleThinkingBudget(gemini("gemini-2.5-flash-lite"), "minimal")).toBe(512);
    expect(getGoogleThinkingBudget(gemini("gemini-2.5-flash"), "xhigh")).toBe(24576);
    expect(getGoogleThinkingBudget(gemini("gemini-2.5-flash"), "low", { low: 999 })).toBe(999);
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    expect(buildGoogleParams(gemini("gemini-2.5-pro"), context).config?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
    expect(buildGoogleParams(gemini(), context).config?.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
    expect(
      buildGoogleParams(gemini("gemini-2.5-pro"), context, { reasoning: "high" }).config
        ?.thinkingConfig,
    ).toEqual({
      includeThoughts: true,
      thinkingBudget: 32768,
    });
    expect(
      buildGoogleParams(gemini(), context, { reasoning: "xhigh" }).config?.thinkingConfig,
    ).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
  });

  it("converts tools: meta declarations stripped for parameters, const sent as enum", () => {
    const [declarations] = convertGoogleTools([tool]) ?? [];
    expect(declarations?.functionDeclarations[0]).toEqual({
      name: "lookup",
      description: "Look something up",
      parametersJsonSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { query: { type: "string" }, mode: { enum: ["fast"] } },
        required: ["query"],
      },
    });
    const [legacy] = convertGoogleTools([tool], true) ?? [];
    expect(legacy?.functionDeclarations[0]?.["parameters"]).not.toHaveProperty("$schema");
    expect(convertGoogleTools([])).toBeUndefined();
  });

  it("replays signatures only to the same model and keeps empty signed parts", () => {
    const model = gemini();
    const previous = assistant(model, [
      { type: "thinking", thinking: "", thinkingSignature: SIG },
      { type: "text", text: "", textSignature: SIG },
      { type: "text", text: "  " },
      {
        type: "toolCall",
        id: "call.1",
        name: "lookup",
        arguments: { query: "x" },
        thoughtSignature: SIG,
      },
    ]);
    const context: Context = {
      messages: [
        { role: "user", content: "find x", timestamp: 1 },
        previous,
        {
          role: "toolResult",
          toolCallId: "call.1",
          toolName: "lookup",
          content: [{ type: "text", text: "found" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    const contents = convertGoogleMessages(model, context);
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { thought: true, text: "", thoughtSignature: SIG },
        { text: "", thoughtSignature: SIG },
        {
          functionCall: { name: "lookup", args: { query: "x" }, id: "call.1" },
          thoughtSignature: SIG,
        },
      ],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "lookup", response: { output: "found" }, id: "call.1" } },
      ],
    });
    // Another model drops the thinking and every signature.
    const other = convertGoogleMessages(gemini("gemini-3-flash-preview"), context);
    expect(other[1]?.parts).toEqual([
      { functionCall: { name: "lookup", args: { query: "x" }, id: "call_1" } },
    ]);
  });

  it("nests tool-result images for Gemini 3 and sends a separate image turn before it", () => {
    const image = { type: "image" as const, data: "aW1n", mimeType: "image/png" };
    const contextFor = (model: Model): Context => ({
      messages: [
        { role: "user", content: "shot", timestamp: 1 },
        assistant(model, [{ type: "toolCall", id: "c1", name: "screenshot", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "screenshot",
          content: [image],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    const three = gemini();
    expect(convertGoogleMessages(three, contextFor(three))[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "screenshot",
            response: { output: "(see attached image)" },
            parts: [{ inlineData: { mimeType: "image/png", data: "aW1n" } }],
            id: "c1",
          },
        },
      ],
    });
    const two = gemini("gemini-2.5-flash");
    const contents = convertGoogleMessages(two, contextFor(two));
    expect(contents[2]?.parts?.[0]).toEqual({
      functionResponse: { name: "screenshot", response: { output: "(see attached image)" } },
    });
    expect(contents[3]).toEqual({
      role: "user",
      parts: [
        { text: "Tool result image:" },
        { inlineData: { mimeType: "image/png", data: "aW1n" } },
      ],
    });
  });

  it("maps tool choice to the function calling mode", () => {
    const context: Context = {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [tool],
    };
    expect(buildGoogleParams(gemini(), context).config?.toolConfig).toBeUndefined();
    expect(buildGoogleParams(gemini(), context, { toolChoice: "none" }).config?.toolConfig).toEqual(
      {
        functionCallingConfig: { mode: "NONE" },
      },
    );
    expect(
      buildGoogleParams(gemini(), context, { toolChoice: { name: "lookup" } }).config?.toolConfig,
    ).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
    });
  });

  it("resolves Gemini defaults for unknown ids", () => {
    const model = resolveModel("google/gemini-3-pro-preview");
    expect(model).toMatchObject({
      api: "google-generative-ai",
      reasoning: true,
      contextWindow: 1_048_576,
    });
    expect(resolveModel("google/gemma-3-27b-it").reasoning).toBe(false);
    expect(resolveModel("google-vertex/gemini-2.5-pro").api).toBe("google-vertex");
  });
});

describe("Google Vertex provider", () => {
  const saved: Record<string, string | undefined> = {};
  const names = [
    "GOOGLE_CLOUD_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ];
  beforeEach(() => {
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("uses a Vertex API key when one is given", async () => {
    const recorded: Recorded[] = [];
    const message = await complete(
      resolveModel("google-vertex/gemini-2.5-flash"),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      {
        apiKey: "vertex-key",
        fetch: replay(
          sse([
            {
              candidates: [
                { content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" },
              ],
            },
          ]),
          recorded,
        ),
      },
    );
    expect(message.stopReason).toBe("stop");
    expect(recorded[0]?.url).toContain("aiplatform.googleapis.com");
    expect(recorded[0]?.url).toContain("gemini-2.5-flash:streamGenerateContent");
  });

  it("needs a project and location without a key", async () => {
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    const model = resolveModel("google-vertex/gemini-2.5-flash");
    expect((await complete(model, context)).errorMessage).toContain(
      "Vertex AI requires a project ID",
    );
    process.env["GOOGLE_CLOUD_PROJECT"] = "p";
    expect((await complete(model, context)).errorMessage).toContain(
      "Vertex AI requires a location",
    );
  });
});

describe("Azure OpenAI provider", () => {
  const saved: Record<string, string | undefined> = {};
  const names = [
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "AZURE_OPENAI_API_KEY",
  ];
  beforeEach(() => {
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("normalizes Azure endpoints to /openai/v1 and leaves proxies alone", () => {
    expect(normalizeAzureBaseUrl("https://r.cognitiveservices.azure.com")).toBe(
      "https://r.cognitiveservices.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://r.ai.azure.com/")).toBe(
      "https://r.ai.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://r.openai.azure.com/openai")).toBe(
      "https://r.openai.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://r.openai.azure.com/openai/v1")).toBe(
      "https://r.openai.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://r.services.ai.azure.com/openai/v1/responses")).toBe(
      "https://r.services.ai.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://r.openai.azure.com/?x=1")).toBe(
      "https://r.openai.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://my-proxy.example.com/v1?custom=true")).toBe(
      "https://my-proxy.example.com/v1?custom=true",
    );
    expect(() => normalizeAzureBaseUrl("not a url")).toThrow("Invalid Azure OpenAI base URL");
  });

  it("resolves the endpoint, API version and deployment from the environment", () => {
    expect(() => resolveAzureConfig({ baseUrl: "" })).toThrow("Azure OpenAI base URL is required");
    process.env["AZURE_OPENAI_RESOURCE_NAME"] = "acme";
    expect(resolveAzureConfig({ baseUrl: "" })).toEqual({
      baseUrl: "https://acme.openai.azure.com/openai/v1",
      apiVersion: "v1",
    });
    process.env["AZURE_OPENAI_BASE_URL"] = "https://other.openai.azure.com";
    process.env["AZURE_OPENAI_API_VERSION"] = "2025-04-01-preview";
    expect(resolveAzureConfig({ baseUrl: "" })).toEqual({
      baseUrl: "https://other.openai.azure.com/openai/v1",
      apiVersion: "2025-04-01-preview",
    });
    process.env["AZURE_OPENAI_DEPLOYMENT_NAME_MAP"] = "gpt-5=prod-gpt5, other=x";
    expect(resolveAzureDeploymentName({ id: "gpt-5" })).toBe("prod-gpt5");
    expect(resolveAzureDeploymentName({ id: "gpt-4o" })).toBe("gpt-4o");
  });

  it("sends a stateless Responses request to the deployment with the api-key header", async () => {
    process.env["AZURE_OPENAI_RESOURCE_NAME"] = "acme";
    process.env["AZURE_OPENAI_DEPLOYMENT_NAME_MAP"] = "gpt-5=prod-gpt5";
    const recorded: Recorded[] = [];
    const body = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_1",
        content_index: 0,
        delta: "Hi",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const message = await complete(
      resolveModel("azure-openai/gpt-5"),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "azure-key", fetch: replay(body, recorded) },
    );
    expect(message.errorMessage).toBeUndefined();
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "Hi" })]);
    const request = recorded[0] as Recorded;
    expect(request.url).toContain("https://acme.openai.azure.com/openai/v1/responses");
    expect(request.headers.get("api-key")).toBe("azure-key");
    expect(request.body).toMatchObject({ model: "prod-gpt5", store: false, stream: true });
  });
});

describe("clampMaxTokensToContext", () => {
  const WINDOW = 1_048_576;
  const model = (contextWindow = WINDOW) => ({ contextWindow });

  it("leaves 15% of the input unused so an overcount still fits", () => {
    const maxTokens = clampMaxTokensToContext(model(), 220_815, 943_718);
    expect(maxTokens).toBe(WINDOW - 220_815 - 33_123);
    expect(229_747 + maxTokens).toBeLessThanOrEqual(WINDOW);
  });

  it("leaves at least 4096 tokens for small inputs", () => {
    expect(clampMaxTokensToContext(model(), 10_000, WINDOW)).toBe(WINDOW - 10_000 - 4096);
  });

  it("keeps the model output limit when it already fits", () => {
    expect(clampMaxTokensToContext(model(), 100_000, 64_000)).toBe(64_000);
  });

  it("sends up to 32768 tokens when the proportional margin leaves no room", () => {
    expect(clampMaxTokensToContext(model(), 912_000, 943_718)).toBe(32_768);
  });

  it("uses the real room minus 4096 when less than 32768 tokens fit", () => {
    expect(clampMaxTokensToContext(model(), 1_030_000, 943_718)).toBe(WINDOW - 1_030_000 - 4096);
  });

  it("keeps only the fixed margin for small windows", () => {
    expect(clampMaxTokensToContext(model(32_768), 20_000, 32_768)).toBe(32_768 - 20_000 - 4096);
  });

  it("sends 1 token when the input already exceeds the window", () => {
    expect(clampMaxTokensToContext(model(), 1_050_000, 943_718)).toBe(1);
  });
});
