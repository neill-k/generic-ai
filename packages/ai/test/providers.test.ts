import { describe, expect, it } from "vitest";
import {
  type AssistantMessageEvent,
  type Context,
  complete,
  resolveModel,
  type StreamOptions,
  stream,
} from "../src/index.js";

/**
 * Provider tests drive each wire API end to end through the official SDK, with a `fetch` that
 * records the request and replays a recorded server-sent event stream. No network, no keys.
 */

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");
}

function replay(body: string, status = 200, record: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    record.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(body, {
      status,
      headers: {
        "content-type": status === 200 ? "text/event-stream" : "application/json",
        "request-id": "req_1",
      },
    });
  }) as typeof fetch;
}

async function collect(events: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

const tool = {
  name: "lookup",
  description: "Look something up",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const context: Context = {
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: "Find the answer", timestamp: 1 }],
  tools: [tool],
};

const base: StreamOptions = { apiKey: "test-key", maxRetries: 0 };

describe("anthropic messages provider", () => {
  const model = resolveModel("anthropic/claude-opus-5-5");

  const toolStream = sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Need a lookup." },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc" },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Checking" },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"que' },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: 'ry":"x"}' },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

  it("streams thinking, text and a tool call with usage and cost", async () => {
    const recorded: Recorded[] = [];
    const events = await collect(
      stream(model, context, { ...base, fetch: replay(toolStream, 200, recorded) }),
    );
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("thinking_end");
    expect(types).toContain("toolcall_end");
    expect(types.at(-1)).toBe("done");

    const done = events.at(-1);
    if (done?.type !== "done") {
      throw new Error("expected done");
    }
    const message = done.message;
    expect(message.stopReason).toBe("toolUse");
    expect(message.responseId).toBe("msg_1");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Need a lookup.", thinkingSignature: "sig-abc" },
      { type: "text", text: "Checking" },
      { type: "toolCall", id: "toolu_1", name: "lookup", arguments: { query: "x" } },
    ]);
    expect(message.usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 200,
    });
    // $4/M input, $20/M output, $0.2/M cache read, $5/M cache write.
    expect(message.usage.cost.total).toBeCloseTo(
      (100 * 4 + 50 * 20 + 40 * 0.2 + 10 * 5) / 1_000_000,
      10,
    );

    const request = recorded[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("x-api-key")).toBe("test-key");
    expect(request?.body["model"]).toBe("claude-opus-5-5");
    expect(request?.body["stream"]).toBe(true);
    expect(request?.body["system"]).toEqual([
      { type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("uses adaptive thinking with effort on current models", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      ...base,
      reasoning: "high",
      fetch: replay(toolStream, 200, recorded),
    });
    const body = recorded[0]?.body ?? {};
    expect(body["thinking"]).toMatchObject({ type: "adaptive" });
    expect(body["output_config"]).toMatchObject({ effort: "high" });
    expect(body).not.toHaveProperty("temperature");
  });

  it("uses budget thinking on budget-mode models", async () => {
    const recorded: Recorded[] = [];
    await complete(resolveModel("anthropic/claude-haiku-4-5"), context, {
      ...base,
      reasoning: "medium",
      fetch: replay(toolStream, 200, recorded),
    });
    const thinking = recorded[0]?.body["thinking"] as { type: string; budget_tokens: number };
    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBeGreaterThan(0);
    expect(recorded[0]?.body["max_tokens"]).toBeGreaterThan(thinking.budget_tokens);
  });

  it("honours cache retention", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      ...base,
      cacheRetention: "none",
      fetch: replay(toolStream, 200, recorded),
    });
    await complete(model, context, {
      ...base,
      cacheRetention: "long",
      fetch: replay(toolStream, 200, recorded),
    });
    expect(JSON.stringify(recorded[0]?.body)).not.toContain("cache_control");
    expect(recorded[1]?.body["system"]).toEqual([
      { type: "text", text: "Be brief.", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("maps tool choice and lets onPayload replace the body", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      ...base,
      toolChoice: "required",
      onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "u1" } }),
      fetch: replay(toolStream, 200, recorded),
    });
    expect(recorded[0]?.body["tool_choice"]).toEqual({ type: "any" });
    expect(recorded[0]?.body["metadata"]).toEqual({ user_id: "u1" });
  });

  it("authenticates subscription OAuth tokens with a bearer header", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      ...base,
      apiKey: "sk-ant-oat-123",
      fetch: replay(toolStream, 200, recorded),
    });
    expect(recorded[0]?.headers.get("authorization")).toBe("Bearer sk-ant-oat-123");
    expect(recorded[0]?.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(recorded[0]?.headers.get("x-api-key")).toBeNull();
  });

  it("turns HTTP errors into a terminal error event", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad request" },
    });
    const events = await collect(stream(model, context, { ...base, fetch: replay(body, 400) }));
    expect(events).toHaveLength(1);
    const terminal = events[0];
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.error.stopReason).toBe("error");
      expect(terminal.error.errorMessage).toContain("bad request");
    }
  });

  it("reports a missing API key without a request", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const recorded: Recorded[] = [];
      const message = await complete(model, context, {
        maxRetries: 0,
        fetch: replay(toolStream, 200, recorded),
      });
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain("ANTHROPIC_API_KEY");
      expect(recorded).toHaveLength(0);
    } finally {
      if (previous !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = previous;
      }
    }
  });

  it("marks an aborted request as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const message = await complete(model, context, {
      ...base,
      signal: controller.signal,
      fetch: replay(toolStream),
    });
    expect(message.stopReason).toBe("aborted");
  });

  it("maps max_tokens to length and refusal to error", async () => {
    const stop = (reason: string) =>
      sse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: reason, stop_sequence: null },
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    const length = await complete(model, context, { ...base, fetch: replay(stop("max_tokens")) });
    expect(length.stopReason).toBe("length");
    const refusal = await complete(model, context, { ...base, fetch: replay(stop("refusal")) });
    expect(refusal.stopReason).toBe("error");
    expect(refusal.rawStopReason).toBe("refusal");
  });
});

describe("openai responses provider", () => {
  const model = resolveModel("openai/gpt-5.5", {
    cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 },
  });

  const responseStream = sse([
    {
      event: "response.created",
      data: { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
    },
    {
      event: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "Thinking",
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Thinking" }],
          encrypted_content: "enc",
        },
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1", role: "assistant", content: [] },
      },
    },
    {
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        delta: "Hello",
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "lookup",
          arguments: "",
        },
      },
    },
    {
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 2,
        delta: '{"query":"y"}',
      },
    },
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"query":"y"}',
        },
      },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            total_tokens: 42,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      },
    },
  ]);

  it("streams reasoning, text and function calls", async () => {
    const recorded: Recorded[] = [];
    const message = await complete(model, context, {
      ...base,
      reasoning: "low",
      sessionId: "s1",
      fetch: replay(responseStream, 200, recorded),
    });
    expect(message.stopReason).toBe("toolUse");
    expect(message.responseId).toBe("resp_1");
    const [thinking, text, call] = message.content;
    expect(thinking).toMatchObject({ type: "thinking", thinking: "Thinking" });
    expect(thinking?.type === "thinking" ? thinking.thinkingSignature : undefined).toContain("enc");
    expect(text).toMatchObject({ type: "text", text: "Hello" });
    expect(call).toEqual({
      type: "toolCall",
      id: "call_1|fc_1",
      name: "lookup",
      arguments: { query: "y" },
    });
    expect(message.usage).toMatchObject({ input: 20, output: 12, cacheRead: 10 });

    const body = recorded[0]?.body ?? {};
    expect(recorded[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(body["store"]).toBe(false);
    expect(body["instructions"]).toBe("Be brief.");
    expect(body["prompt_cache_key"]).toBe("s1");
    expect(body["reasoning"]).toEqual({ effort: "low", summary: "auto" });
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
  });

  it("replays its own reasoning and tool calls on the next turn", async () => {
    const first = await complete(model, context, { ...base, fetch: replay(responseStream) });
    const recorded: Recorded[] = [];
    await complete(
      model,
      {
        ...context,
        messages: [
          ...context.messages,
          first,
          {
            role: "toolResult",
            toolCallId: "call_1|fc_1",
            toolName: "lookup",
            content: [{ type: "text", text: "42" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
      { ...base, fetch: replay(responseStream, 200, recorded) },
    );
    const input = recorded[0]?.body["input"] as Array<Record<string, unknown>>;
    expect(
      input.some((item) => item["type"] === "reasoning" && item["encrypted_content"] === "enc"),
    ).toBe(true);
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_1", name: "lookup" }),
    );
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "42" }),
    );
  });

  it("drops the prompt cache key when caching is off", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      ...base,
      sessionId: "s1",
      cacheRetention: "none",
      fetch: replay(responseStream, 200, recorded),
    });
    expect(recorded[0]?.body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("openai chat completions provider", () => {
  const model = resolveModel("openrouter/qwen/qwen3-coder");

  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    data: {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "qwen/qwen3-coder",
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    },
  });

  const completionStream = sse([
    chunk({ role: "assistant", reasoning_content: "Plan" }),
    chunk({ content: "Sure" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_9",
          type: "function",
          function: { name: "lookup", arguments: '{"query"' },
        },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':"z"}' } }] }),
    {
      data: {
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen/qwen3-coder",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    },
    { data: "[DONE]" },
  ]);

  it("streams reasoning, text and tool calls", async () => {
    const recorded: Recorded[] = [];
    const message = await complete(model, context, {
      ...base,
      fetch: replay(completionStream, 200, recorded),
    });
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      expect.objectContaining({ type: "thinking", thinking: "Plan" }),
      { type: "text", text: "Sure" },
      { type: "toolCall", id: "call_9", name: "lookup", arguments: { query: "z" } },
    ]);
    expect(message.usage).toMatchObject({ input: 16, output: 5, cacheRead: 4 });

    const body = recorded[0]?.body ?? {};
    expect(recorded[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body["stream"]).toBe(true);
    const messages = body["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({
      role: expect.stringMatching(/system|developer/),
      content: "Be brief.",
    });
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "lookup", description: tool.description, parameters: tool.parameters },
      },
    ]);
  });

  it("maps finish_reason length", async () => {
    const body = sse([
      chunk({ content: "cut" }),
      {
        data: {
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      },
      { data: "[DONE]" },
    ]);
    const message = await complete(model, context, { ...base, fetch: replay(body) });
    expect(message.stopReason).toBe("length");
  });
});
