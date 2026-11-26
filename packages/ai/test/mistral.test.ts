// Native Mistral provider tests, driven with a recording `fetch` that replays SSE. No live calls.
// Cases ported from pi's `mistral-*` suites (badlogic/pi-mono, MIT).

import { describe, expect, it } from "vitest";

import {
  type AssistantMessage,
  type Context,
  complete,
  createMistralToolCallIdNormalizer,
  type Model,
  mapMistralStopReason,
  mistralChatUrl,
  resolveModel,
  SseDecoder,
  stream,
} from "../src/index.js";

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function sseBody(events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\r\n\r\n")}\r\n\r\ndata: [DONE]\r\n\r\n`;
}

function replay(
  body: string | (() => BodyInit),
  record: Recorded[] = [],
  status = 200,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    record.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(typeof body === "function" ? body() : body, {
      status,
      headers: {
        "content-type": status === 200 ? "text/event-stream" : "application/json",
        ...headers,
      },
    });
  }) as typeof fetch;
}

function terminal(finishReason = "stop") {
  return {
    id: "mistral-response-id",
    model: "mistral-large-latest",
    choices: [{ index: 0, finish_reason: finishReason, delta: {} }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(id = "mistral-large-latest", overrides: Partial<Model> = {}): Model {
  return resolveModel({ provider: "mistral", id }, { maxTokens: 16_384, ...overrides });
}

const hello: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

describe("Mistral defaults", () => {
  it("routes mistral models to the native API and resolves the chat URL", () => {
    const resolved = model();
    expect(resolved.api).toBe("mistral-conversations");
    expect(mistralChatUrl(resolved.baseUrl)).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(mistralChatUrl("https://proxy.example/v1/")).toBe(
      "https://proxy.example/v1/chat/completions",
    );
    expect(mistralChatUrl("https://proxy.example/mistral")).toBe(
      "https://proxy.example/mistral/v1/chat/completions",
    );
    expect(model("magistral-medium-latest").reasoning).toBe(true);
    expect(model("mistral-large-latest").reasoning).toBe(false);
  });
});

describe("Mistral HTTP transport", () => {
  it("serializes the request in the Mistral wire format", async () => {
    const record: Recorded[] = [];
    const tool = {
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const message = await complete(
      model(),
      {
        systemPrompt: "Be brief.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
        tools: [tool],
      },
      {
        apiKey: "test-key",
        fetch: replay(sseBody([terminal()]), record),
        temperature: 0.2,
        maxTokens: 100,
        toolChoice: { name: "lookup" },
        sessionId: "session-1",
      },
    );

    expect(message.stopReason).toBe("stop");
    expect(record).toHaveLength(1);
    expect(record[0]?.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(record[0]?.headers.get("authorization")).toBe("Bearer test-key");
    expect(record[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(record[0]?.headers.get("x-affinity")).toBe("session-1");
    expect(record[0]?.body).toEqual({
      model: "mistral-large-latest",
      stream: true,
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: tool.parameters,
            strict: false,
          },
        },
      ],
      temperature: 0.2,
      max_tokens: 100,
      tool_choice: { type: "function", function: { name: "lookup" } },
      prompt_cache_key: "session-1",
    });
  });

  it("serializes assistant thinking, tool calls, and tool results for replay", async () => {
    const record: Recorded[] = [];
    const resolved = model();
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "mistral-conversations",
      provider: "mistral",
      model: resolved.id,
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
      ],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    await complete(
      resolved,
      {
        messages: [
          assistant,
          {
            role: "toolResult",
            toolCallId: "abc123456",
            toolName: "lookup",
            content: [
              { type: "text", text: "found" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { apiKey: "test", fetch: replay(sseBody([terminal()]), record) },
    );

    expect(record[0]?.body["messages"]).toEqual([
      {
        role: "assistant",
        prefix: false,
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "reason" }] },
          { type: "text", text: "answer" },
        ],
        tool_calls: [
          {
            id: "abc123456",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"pi"}' },
            index: 0,
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "abc123456",
        name: "lookup",
        content: [
          { type: "text", text: "found" },
          { type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ]);
  });

  it("rewrites foreign tool-call ids to stable 9-character ids", async () => {
    const record: Recorded[] = [];
    const resolved = model();
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      content: [{ type: "toolCall", id: "toolu_01AbCdEf|x", name: "lookup", arguments: {} }],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    await complete(
      resolved,
      {
        messages: [
          assistant,
          {
            role: "toolResult",
            toolCallId: "toolu_01AbCdEf|x",
            toolName: "lookup",
            content: [],
            isError: true,
            timestamp: 2,
          },
        ],
      },
      { apiKey: "test", fetch: replay(sseBody([terminal()]), record) },
    );
    const messages = record[0]?.body["messages"] as {
      tool_calls?: { id: string }[];
      tool_call_id?: string;
      content?: unknown;
    }[];
    const id = messages[0]?.tool_calls?.[0]?.id ?? "";
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(messages[1]?.tool_call_id).toBe(id);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "[tool error] (no tool output)" }]);

    const normalize = createMistralToolCallIdNormalizer();
    expect(normalize("abc123456")).toBe("abc123456");
    expect(normalize("call-1")).toBe(normalize("call-1"));
    expect(normalize("call-1")).not.toBe(normalize("call-2"));
  });

  it("replaces images with a placeholder for text-only models", async () => {
    const record: Recorded[] = [];
    await complete(
      model("mistral-large-latest", { input: ["text"] }),
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
            timestamp: 1,
          },
        ],
      },
      { apiKey: "test", fetch: replay(sseBody([terminal()]), record) },
    );
    expect(record[0]?.body["messages"]).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
      },
    ]);
  });

  it("parses native thinking, text, fragmented tool calls, and cached-token usage", async () => {
    const resolved = model("mistral-large-latest", {
      cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
    });
    const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) => ({
      id: "response-1",
      model: resolved.id,
      choices: [{ index: 0, finish_reason: finish, delta }],
      ...extra,
    });
    const events = [
      chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "reason" }] }] }),
      chunk({ content: [{ type: "text", text: "answer" }] }),
      chunk({
        tool_calls: [
          { id: "abc123456", index: 0, function: { name: "lookup", arguments: '{"query":' } },
        ],
      }),
      chunk(
        { tool_calls: [{ index: 0, function: { name: "", arguments: '"pi"}' } }] },
        "tool_calls",
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
      ),
    ];
    const types: string[] = [];
    const events$ = stream(resolved, hello, { apiKey: "test", fetch: replay(sseBody(events)) });
    for await (const event of events$) {
      types.push(event.type);
    }
    const message = await events$.result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.rawStopReason).toBe("tool_calls");
    expect(message.responseId).toBe("response-1");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "abc123456", name: "lookup", arguments: { query: "pi" } },
    ]);
    expect(message.usage).toMatchObject({
      input: 7,
      output: 4,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 14,
    });
    expect(message.usage.cost.total).toBeCloseTo((7 * 2 + 4 * 6 + 3 * 0.2) / 1_000_000);
    expect(types).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
  });

  it("ignores empty content deltas so thinking stays one block", async () => {
    const thinking = (text: string) => ({ type: "thinking", thinking: [{ type: "text", text }] });
    const toolCall = (args: string, first: boolean) => ({
      index: 0,
      ...(first ? { id: "abc123456" } : {}),
      function: { name: first ? "read" : "", arguments: args },
    });
    const deltas = [
      { content: "" },
      { content: [thinking("first part,")] },
      { content: "" },
      { content: [{ type: "text", text: "" }] },
      { content: [thinking(" second part."), { type: "text", text: "Reading." }] },
      { content: "", tool_calls: [toolCall("", true)] },
      { content: "", tool_calls: [toolCall('{"path":', false)] },
      { content: "", tool_calls: [toolCall('"a.txt"}', false)] },
      { content: "" },
    ];
    const events = deltas.map((delta, index) => ({
      id: "response-1",
      choices: [
        { index: 0, finish_reason: index === deltas.length - 1 ? "tool_calls" : null, delta },
      ],
    }));
    const message = await complete(model("zai-glm-5-3"), hello, {
      apiKey: "test",
      fetch: replay(sseBody(events)),
    });
    expect(message.content).toEqual([
      { type: "thinking", thinking: "first part, second part." },
      { type: "text", text: "Reading." },
      { type: "toolCall", id: "abc123456", name: "read", arguments: { path: "a.txt" } },
    ]);
  });

  it("parses SSE and UTF-8 sequences split across transport chunks", async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({
        id: "response-bytewise",
        choices: [{ index: 0, finish_reason: "stop", delta: { content: "héllo 🌍" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })}\r\n\r\ndata: [DONE]\r\n\r\n`,
    );
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) {
            controller.enqueue(Uint8Array.of(byte));
          }
          controller.close();
        },
      });
    const message = await complete(model(), hello, { apiKey: "test", fetch: replay(body) });
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "héllo 🌍" }]);
  });

  it("lets explicit headers override affinity and defaults", async () => {
    const record: Recorded[] = [];
    await complete(model("mistral-large-latest", { headers: { "X-Affinity": "pinned" } }), hello, {
      apiKey: "test",
      sessionId: "session-1",
      headers: { "x-custom": "1" },
      fetch: replay(sseBody([terminal()]), record),
    });
    expect(record[0]?.headers.get("x-affinity")).toBe("pinned");
    expect(record[0]?.headers.get("x-custom")).toBe("1");

    const noCache: Recorded[] = [];
    await complete(model(), hello, {
      apiKey: "test",
      sessionId: "session-1",
      cacheRetention: "none",
      fetch: replay(sseBody([terminal()]), noCache),
    });
    expect(noCache[0]?.headers.get("x-affinity")).toBeNull();
    expect(noCache[0]?.body["prompt_cache_key"]).toBeUndefined();
  });

  it("aborts while waiting for an SSE chunk", async () => {
    const controller = new AbortController();
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
        },
      });
    const pending = complete(model(), hello, {
      apiKey: "test",
      signal: controller.signal,
      fetch: replay(body),
    });
    setTimeout(() => controller.abort(), 20);
    const message = await pending;
    expect(message.stopReason).toBe("aborted");
  });

  it("preserves the HTTP status and body in errors, retrying only retryable statuses", async () => {
    const record: Recorded[] = [];
    const message = await complete(model(), hello, {
      apiKey: "test",
      fetch: replay('{"message":"Invalid model"}', record, 400),
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe('Mistral API error (400): {"message":"Invalid model"}');
    expect(record).toHaveLength(1);

    const retried: Recorded[] = [];
    const overloaded = await complete(model(), hello, {
      apiKey: "test",
      maxRetries: 1,
      fetch: replay("overloaded", retried, 503, { "retry-after-ms": "1" }),
    });
    expect(overloaded.errorMessage).toBe("Mistral API error (503): overloaded");
    expect(retried).toHaveLength(2);
  });

  it("reports a missing key and a stream that ends without a finish reason", async () => {
    const saved = process.env["MISTRAL_API_KEY"];
    delete process.env["MISTRAL_API_KEY"];
    try {
      const missing = await complete(model(), hello, { fetch: replay(sseBody([terminal()])) });
      expect(missing.stopReason).toBe("error");
      expect(missing.errorMessage).toContain("MISTRAL_API_KEY");
    } finally {
      if (saved !== undefined) process.env["MISTRAL_API_KEY"] = saved;
    }
    const unfinished = await complete(model(), hello, {
      apiKey: "test",
      fetch: replay(
        sseBody([
          { id: "r", choices: [{ index: 0, finish_reason: null, delta: { content: "hi" } }] },
        ]),
      ),
    });
    expect(unfinished.stopReason).toBe("error");
    expect(unfinished.errorMessage).toBe("Mistral stream ended without a finish reason");
  });
});

describe("Mistral raw stop reasons", () => {
  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["model_length", "length"],
    ["tool_calls", "toolUse"],
  ] as const)("maps %s to %s", async (raw, mapped) => {
    expect(mapMistralStopReason(raw).stopReason).toBe(mapped);
    const message = await complete(model(), hello, {
      apiKey: "test",
      fetch: replay(sseBody([terminal(raw)])),
    });
    expect(message.rawStopReason).toBe(raw);
  });

  it("treats error and unknown finish reasons as provider error stops", async () => {
    for (const raw of ["error", "something_new"]) {
      const message = await complete(model(), hello, {
        apiKey: "test",
        fetch: replay(sseBody([terminal(raw)])),
      });
      expect(message.stopReason).toBe("error");
      expect(message.rawStopReason).toBe(raw);
      expect(message.errorMessage).toBe(`Provider stopped with: ${raw}`);
    }
  });
});

describe("Mistral reasoning mode selection", () => {
  const noneHigh = { off: "none", high: "high" } as const;
  const glm53 = { low: "low", high: "high", xhigh: "max" } as const;

  async function payload(target: Model, options: Parameters<typeof complete>[2] = {}) {
    const record: Recorded[] = [];
    await complete(target, hello, {
      apiKey: "test",
      fetch: replay(sseBody([terminal()]), record),
      ...options,
    });
    return record[0]?.body ?? {};
  }

  it("uses prompt_mode for reasoning models without a level map (Magistral)", async () => {
    const body = await payload(model("magistral-medium-latest"), { reasoning: "medium" });
    expect(body["prompt_mode"]).toBe("reasoning");
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  it("omits reasoning controls for Magistral when thinking is off", async () => {
    const body = await payload(model("magistral-medium-latest"));
    expect(body["prompt_mode"]).toBeUndefined();
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  describe.each(["mistral-small-2603", "mistral-medium-latest"])("%s", (id) => {
    const target = model(id, { reasoning: true, thinkingLevelMap: noneHigh });

    it("uses reasoning_effort when thinking is enabled", async () => {
      const body = await payload(target, { reasoning: "high" });
      expect(body["reasoning_effort"]).toBe("high");
      expect(body["prompt_mode"]).toBeUndefined();
    });

    it("clamps unsupported levels to a supported effort", async () => {
      expect((await payload(target, { reasoning: "low" }))["reasoning_effort"]).toBe("high");
      expect((await payload(target, { reasoning: "xhigh" }))["reasoning_effort"]).toBe("high");
    });

    it("sends the map's off value when thinking is off", async () => {
      const body = await payload(target);
      expect(body["reasoning_effort"]).toBe("none");
      expect(body["prompt_mode"]).toBeUndefined();
    });
  });

  it("maps levels for hosted GLM, rounding medium up to high", async () => {
    const target = model("zai-glm-5-3", { reasoning: true, thinkingLevelMap: glm53 });
    expect((await payload(target, { reasoning: "low" }))["reasoning_effort"]).toBe("low");
    expect((await payload(target, { reasoning: "medium" }))["reasoning_effort"]).toBe("high");
    expect((await payload(target, { reasoning: "xhigh" }))["reasoning_effort"]).toBe("max");
    expect((await payload(target))["reasoning_effort"]).toBeUndefined();
  });

  it("omits reasoning controls for non-reasoning models", async () => {
    const body = await payload(model("mistral-medium-2505"), { reasoning: "medium" });
    expect(body["reasoning_effort"]).toBeUndefined();
    expect(body["prompt_mode"]).toBeUndefined();
  });
});

describe("Mistral tool schemas", () => {
  it("strips symbol keys from tool schemas", async () => {
    const record: Recorded[] = [];
    const parameters: Record<string | symbol, unknown> = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    parameters[Symbol.for("TypeBox.Kind")] = "Object";
    await complete(
      model(),
      {
        ...hello,
        tools: [{ name: "lookup", description: "Look up", parameters: parameters as never }],
      },
      { apiKey: "test", fetch: replay(sseBody([terminal()]), record) },
    );
    const tools = record[0]?.body["tools"] as {
      function: { parameters: object; strict: boolean };
    }[];
    expect(Object.getOwnPropertySymbols(tools[0]?.function.parameters ?? {})).toEqual([]);
    expect(tools[0]?.function.strict).toBe(false);
  });
});

describe("SseDecoder", () => {
  it("handles CRLF, comments, multi-line data and a final event without a blank line", () => {
    const decoder = new SseDecoder();
    const encoder = new TextEncoder();
    const events = [
      ...decoder.push(encoder.encode(": comment\r\nevent: delta\r\ndata: a\r")),
      ...decoder.push(encoder.encode("\ndata: b\r\n\r\ndata: c")),
      ...decoder.end(),
    ];
    expect(events).toEqual([{ event: "delta", data: "a\nb" }, { data: "c" }]);
  });
});
