// Amazon Bedrock provider tests. The real AWS SDK runs end to end against a recording `fetch` that
// replays AWS event-stream frames, so nothing calls AWS. Cases ported from pi's `bedrock-*` suites
// (badlogic/pi-mono, MIT).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AssistantMessage,
  bedrockAdditionalFields,
  bedrockSupportsPromptCaching,
  buildBedrockCommandInput,
  type Context,
  complete,
  convertBedrockMessages,
  formatBedrockError,
  type Model,
  mapBedrockStopReason,
  resolveBedrockClientConfig,
  resolveModel,
  stream,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// AWS event-stream encoding (application/vnd.amazon.eventstream)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const headerParts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    headerParts.push(
      nameBytes.length,
      ...nameBytes,
      7,
      valueBytes.length >> 8,
      valueBytes.length & 0xff,
      ...valueBytes,
    );
  }
  const headerBytes = Uint8Array.from(headerParts);
  const body = encoder.encode(JSON.stringify(payload));
  const total = 12 + headerBytes.length + body.length + 4;
  const message = new Uint8Array(total);
  const view = new DataView(message.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(message.subarray(0, 8)));
  message.set(headerBytes, 12);
  message.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(message.subarray(0, total - 4)));
  return message;
}

type BedrockEvent = Record<string, unknown>;

function eventStream(events: BedrockEvent[]): Uint8Array {
  const frames = events.map((event) => {
    const [type, payload] = Object.entries(event)[0] as [string, unknown];
    const isException = type.endsWith("Exception");
    return frame(
      isException
        ? {
            ":message-type": "exception",
            ":exception-type": type,
            ":content-type": "application/json",
          }
        : { ":message-type": "event", ":event-type": type, ":content-type": "application/json" },
      payload,
    );
  });
  const size = frames.reduce((sum, item) => sum + item.length, 0);
  const all = new Uint8Array(size);
  let offset = 0;
  for (const item of frames) {
    all.set(item, offset);
    offset += item.length;
  }
  return all;
}

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function replay(
  events: BedrockEvent[],
  record: Recorded[] = [],
  failure?: { status: number; type: string; message: string },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body;
    const text =
      typeof raw === "string" ? raw : raw ? new TextDecoder().decode(raw as Uint8Array) : "";
    record.push({
      url,
      headers: new Headers(init?.headers),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    });
    if (failure) {
      return new Response(JSON.stringify({ message: failure.message }), {
        status: failure.status,
        headers: { "content-type": "application/json", "x-amzn-errortype": failure.type },
      });
    }
    return new Response(eventStream(events) as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": "request-1",
      },
    });
  }) as typeof fetch;
}

const AWS_ENV = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_BEDROCK_SKIP_AUTH",
  "AWS_BEDROCK_FORCE_CACHE",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(AWS_ENV.map((name) => [name, process.env[name]]));
  for (const name of AWS_ENV) {
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(id = "us.anthropic.claude-opus-5-5-v1:0", overrides: Partial<Model> = {}): Model {
  return resolveModel(
    { provider: "amazon-bedrock", id },
    { name: id, reasoning: true, maxTokens: 32_000, ...overrides },
  );
}

const hello: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const finished = (stopReason = "end_turn"): BedrockEvent[] => [
  { messageStop: { stopReason } },
  {
    metadata: {
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      metrics: { latencyMs: 1 },
    },
  },
];

describe("Bedrock through the AWS SDK", () => {
  it("streams text, signed thinking and tool calls with usage and cost", async () => {
    const record: Recorded[] = [];
    const target = model("us.anthropic.claude-opus-5-5-v1:0", {
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
    const events: BedrockEvent[] = [
      { messageStart: { role: "assistant" } },
      {
        contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "plan" } } },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: "sig" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Looking." } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      {
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "tool-1", name: "lookup" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"query":' } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '"pi"}' } } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
      { messageStop: { stopReason: "tool_use" } },
      {
        metadata: {
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 6,
            cacheWriteInputTokens: 2,
            totalTokens: 22,
          },
          metrics: { latencyMs: 1 },
        },
      },
    ];
    const statuses: number[] = [];
    const types: string[] = [];
    const response = stream(target, hello, {
      apiKey: "bedrock-api-key",
      fetch: replay(events, record),
      onResponse: ({ status }) => {
        statuses.push(status);
      },
    });
    for await (const event of response) {
      types.push(event.type);
    }
    const message = await response.result();

    expect(message.errorMessage).toBeUndefined();
    expect(message.stopReason).toBe("toolUse");
    expect(message.rawStopReason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
      { type: "text", text: "Looking." },
      { type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "pi" } },
    ]);
    expect(message.usage).toMatchObject({
      input: 10,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      totalTokens: 22,
    });
    expect(message.usage.cost.total).toBeCloseTo((10 * 4 + 4 * 20 + 6 * 0.2 + 2 * 5) / 1_000_000);
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
    expect(statuses).toEqual([200]);
    expect(record[0]?.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1%3A0/converse-stream",
    );
    expect(record[0]?.headers.get("authorization")).toBe("Bearer bedrock-api-key");
  });

  it("signs with SigV4 from environment keys and sends custom headers inside the signature", async () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIDEXAMPLE";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
    process.env["AWS_REGION"] = "eu-west-1";
    const record: Recorded[] = [];
    await complete(model("anthropic.claude-sonnet-4-6"), hello, {
      fetch: replay([{ messageStart: { role: "assistant" } }, ...finished()], record),
      headers: { "x-team": "research", authorization: "ignored", "X-Amz-Date": "ignored" },
    });
    const headers = record[0]?.headers;
    expect(record[0]?.url).toContain("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(headers?.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers?.get("authorization")).toContain("x-team");
    expect(headers?.get("x-team")).toBe("research");
    expect(headers?.get("x-amz-date")).not.toBe("ignored");
  });

  it("keeps encrypted reasoning as base64 and replays it as redacted content", async () => {
    const bytes = new TextEncoder().encode("opaque-reasoning");
    const encoded = btoa(String.fromCharCode(...bytes));
    const target = model("openai.gpt-5-6", { thinkingLevelMap: {} });
    const message = await complete(target, hello, {
      apiKey: "key",
      fetch: replay([
        { messageStart: { role: "assistant" } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: encoded } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        ...finished(),
      ]),
    });
    expect(message.content).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: encoded,
        redacted: true,
      },
    ]);

    const replayed = convertBedrockMessages(target, [message], "none");
    expect(replayed[0]?.content?.[0]?.reasoningContent?.redactedContent).toEqual(bytes);
  });

  it("maps HTTP exceptions to prefixed errors and mid-stream exceptions too", async () => {
    const throttled = await complete(model(), hello, {
      apiKey: "key",
      maxRetries: 0,
      fetch: replay([], [], {
        status: 429,
        type: "ThrottlingException",
        message: "Too many tokens",
      }),
    });
    expect(throttled.stopReason).toBe("error");
    expect(throttled.errorMessage).toBe("Throttling error: Too many tokens");

    const midStream = await complete(model(), hello, {
      apiKey: "key",
      fetch: replay([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
        { modelStreamErrorException: { message: "stream broke", originalStatusCode: 500 } },
      ]),
    });
    expect(midStream.stopReason).toBe("error");
    expect(midStream.errorMessage).toBe("Model stream error: stream broke");
  });

  it("retries throttling through the SDK up to maxRetries", async () => {
    const record: Recorded[] = [];
    await complete(model(), hello, {
      apiKey: "key",
      maxRetries: 1,
      fetch: replay([], record, {
        status: 503,
        type: "ServiceUnavailableException",
        message: "busy",
      }),
    });
    expect(record).toHaveLength(2);
  });

  it("reports a stream that ends without a stop reason and unknown stop reasons", async () => {
    const unfinished = await complete(model(), hello, {
      apiKey: "key",
      fetch: replay([{ messageStart: { role: "assistant" } }]),
    });
    expect(unfinished.errorMessage).toBe("Bedrock stream ended without a stop reason");

    const guardrail = await complete(model(), hello, {
      apiKey: "key",
      fetch: replay([{ messageStart: { role: "assistant" } }, ...finished("guardrail_intervened")]),
    });
    expect(guardrail.stopReason).toBe("error");
    expect(guardrail.rawStopReason).toBe("guardrail_intervened");
    expect(guardrail.errorMessage).toBe("Provider stopped with: guardrail_intervened");
  });
});

describe("Bedrock stop reasons and errors", () => {
  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "toolUse"],
  ] as const)("maps %s to %s", (raw, mapped) => {
    expect(mapBedrockStopReason(raw).stopReason).toBe(mapped);
  });

  it("adds the data retention docs hint", () => {
    const error = Object.assign(new Error("data retention mode 'default' is not available"), {
      name: "ValidationException",
    });
    expect(formatBedrockError(error)).toBe(
      "Validation error: data retention mode 'default' is not available See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html for supported data retention modes.",
    );
  });
});

describe("Bedrock client configuration", () => {
  it("defaults to us-east-1 and uses a bearer token from the key or environment", () => {
    const config = resolveBedrockClientConfig(model(), undefined, {
      AWS_BEARER_TOKEN_BEDROCK: "env-token",
    });
    expect(config.region).toBe("us-east-1");
    expect(config.token).toEqual({ token: "env-token" });
    expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
    expect(config.endpoint).toBeUndefined();
    expect(resolveBedrockClientConfig(model(), { apiKey: "explicit" }, {}).token).toEqual({
      token: "explicit",
    });
  });

  it("takes the region from an inference profile ARN over the environment", () => {
    const arn = "arn:aws:bedrock:ap-southeast-2:123456789012:application-inference-profile/abc";
    expect(
      resolveBedrockClientConfig(model(arn), undefined, { AWS_REGION: "us-west-2" }).region,
    ).toBe("ap-southeast-2");
  });

  it("pins a standard endpoint only when no region or profile is configured", () => {
    const standard = model("anthropic.claude-sonnet-4-6", {
      baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com",
    });
    const pinned = resolveBedrockClientConfig(standard, undefined, {});
    expect(pinned.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
    expect(pinned.region).toBe("eu-central-1");
    const withRegion = resolveBedrockClientConfig(standard, undefined, { AWS_REGION: "us-west-2" });
    expect(withRegion.endpoint).toBeUndefined();
    expect(withRegion.region).toBe("us-west-2");
    const withProfile = resolveBedrockClientConfig(standard, undefined, { AWS_PROFILE: "work" });
    expect(withProfile.endpoint).toBeUndefined();
    expect(withProfile.profile).toBe("work");
    expect(withProfile.region).toBeUndefined();
  });

  it("always uses a custom endpoint", () => {
    const proxy = model("anthropic.claude-sonnet-4-6", {
      baseUrl: "https://bedrock.internal.example",
    });
    const config = resolveBedrockClientConfig(proxy, undefined, { AWS_REGION: "us-west-2" });
    expect(config.endpoint).toBe("https://bedrock.internal.example");
    expect(config.region).toBe("us-west-2");
  });

  it("uses environment keys unless a profile is configured, and dummy keys when auth is skipped", () => {
    const keys = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "t",
    };
    expect(resolveBedrockClientConfig(model(), undefined, keys).credentials).toEqual({
      accessKeyId: "id",
      secretAccessKey: "secret",
      sessionToken: "t",
    });
    expect(
      resolveBedrockClientConfig(model(), undefined, { ...keys, AWS_PROFILE: "work" }).credentials,
    ).toBeUndefined();
    const skipped = resolveBedrockClientConfig(
      model(),
      { apiKey: "k" },
      { AWS_BEDROCK_SKIP_AUTH: "1" },
    );
    expect(skipped.credentials).toEqual({
      accessKeyId: "dummy-access-key",
      secretAccessKey: "dummy-secret-key",
    });
    expect(skipped.token).toBeUndefined();
  });
});

describe("Bedrock request conversion", () => {
  it("builds system, cache points, inference config and tools for Claude", () => {
    const input = buildBedrockCommandInput(
      model(),
      {
        systemPrompt: "Be brief.",
        messages: hello.messages,
        tools: [
          {
            name: "lookup",
            description: "Look up",
            parameters: {
              type: "object",
              properties: { "": { type: "string" }, q: { type: "string" } },
            },
          },
        ],
      },
      { temperature: 0.3, toolChoice: { name: "lookup" }, cacheRetention: "long" },
      {},
    );
    expect(input.system).toEqual([
      { text: "Be brief." },
      { cachePoint: { type: "default", ttl: "1h" } },
    ]);
    expect(input.messages).toEqual([
      {
        role: "user",
        content: [{ text: "hello" }, { cachePoint: { type: "default", ttl: "1h" } }],
      },
    ]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 32_000, temperature: 0.3 });
    expect(input.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "lookup",
            description: "Look up",
            inputSchema: { json: { type: "object", properties: { q: { type: "string" } } } },
          },
        },
      ],
      toolChoice: { tool: { name: "lookup" } },
    });
    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it("omits cache points when disabled or unsupported, unless forced", () => {
    expect(bedrockSupportsPromptCaching(model("amazon.nova-pro-v1:0"), {})).toBe(false);
    expect(
      bedrockSupportsPromptCaching(model("amazon.nova-pro-v1:0"), { AWS_BEDROCK_FORCE_CACHE: "1" }),
    ).toBe(true);
    expect(
      bedrockSupportsPromptCaching(model("anthropic.claude-3-7-sonnet-20250219-v1:0"), {}),
    ).toBe(true);
    const off = buildBedrockCommandInput(
      model(),
      { ...hello, systemPrompt: "s" },
      { cacheRetention: "none" },
      {},
    );
    expect(off.system).toEqual([{ text: "s" }]);
    expect(off.messages?.[0]?.content).toEqual([{ text: "hello" }]);
  });

  it("drops tools for tool choice none and maps required to any", () => {
    const tools = [{ name: "t", description: "d", parameters: { type: "object" } }];
    expect(
      buildBedrockCommandInput(model(), { ...hello, tools }, { toolChoice: "none" }, {}).toolConfig,
    ).toBeUndefined();
    expect(
      buildBedrockCommandInput(model(), { ...hello, tools }, { toolChoice: "required" }, {})
        .toolConfig?.toolChoice,
    ).toEqual({ any: {} });
  });

  it("groups tool results into one user message and moves Claude error images after them", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-5-5-v1:0",
      content: [
        { type: "thinking", thinking: "why", thinkingSignature: "sig" },
        { type: "thinking", thinking: "unsigned" },
        { type: "text", text: "  " },
        { type: "toolCall", id: "a", name: "shot", arguments: {} },
        { type: "toolCall", id: "b", name: "read", arguments: { path: "x" } },
      ],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const messages = convertBedrockMessages(
      model(),
      [
        assistant,
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "shot",
          content: [image],
          isError: true,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "b",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 3,
        },
      ],
      "none",
      {},
    );
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { reasoningContent: { reasoningText: { text: "why", signature: "sig" } } },
        { text: "unsigned" },
        { toolUse: { toolUseId: "a", name: "shot", input: {} } },
        { toolUse: { toolUseId: "b", name: "read", input: { path: "x" } } },
      ],
    });
    const bytes = new TextEncoder().encode("hello");
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "a",
            content: [{ text: "(image omitted from error result)" }],
            status: "error",
          },
        },
        { toolResult: { toolUseId: "b", content: [{ text: "<empty>" }], status: "success" } },
        { text: "Images from the error result of tool call a (shot):" },
        { image: { format: "png", source: { bytes } } },
      ],
    });
  });

  it("omits thinking signatures for non-Claude models", () => {
    const target = model("qwen.qwen3-235b", { reasoning: false });
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: target.id,
      content: [
        { type: "thinking", thinking: "why", thinkingSignature: "sig" },
        { type: "text", text: "ok" },
      ],
      usage,
      stopReason: "stop",
      timestamp: 1,
    };
    expect(convertBedrockMessages(target, [assistant], "none", {})[0]?.content).toEqual([
      { reasoningContent: { reasoningText: { text: "why" } } },
      { text: "ok" },
    ]);
  });
});

describe("Bedrock thinking payloads", () => {
  it("uses adaptive thinking with effort, display and block binding on Claude 5", () => {
    expect(bedrockAdditionalFields(model(), { reasoning: "xhigh" }, {})).toEqual({
      thinking: {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      output_config: { effort: "xhigh" },
      anthropic_beta: ["thinking-binding-controls-2026-08-01"],
    });
  });

  it("skips block binding on Claude 4.6 and clamps xhigh to high there", () => {
    expect(
      bedrockAdditionalFields(model("anthropic.claude-sonnet-4-6"), { reasoning: "xhigh" }, {}),
    ).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it("omits display and block binding on GovCloud", () => {
    expect(
      bedrockAdditionalFields(
        model("us-gov.anthropic.claude-opus-5-5-v1:0"),
        { reasoning: "low" },
        {},
      ),
    ).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });

  it("uses a token budget with interleaved thinking for older Claude and raises maxTokens", () => {
    const older = model("anthropic.claude-3-7-sonnet-20250219-v1:0", { maxTokens: 8000 });
    expect(bedrockAdditionalFields(older, { reasoning: "medium" }, {})).toEqual({
      thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    });
    const input = buildBedrockCommandInput(older, hello, { reasoning: "medium" }, {});
    expect(input.inferenceConfig?.maxTokens).toBe(8192 + 4096);
    expect(
      bedrockAdditionalFields(older, { reasoning: "high", thinkingBudgets: { high: 3000 } }, {}),
    ).toMatchObject({ thinking: { budget_tokens: 3000 } });
  });

  it("sends nothing when reasoning is off for Claude", () => {
    expect(bedrockAdditionalFields(model(), undefined, {})).toBeUndefined();
  });

  it("maps OpenAI GPT and gpt-oss efforts", () => {
    expect(bedrockAdditionalFields(model("openai.gpt-5-6"), { reasoning: "minimal" }, {})).toEqual({
      reasoning: { effort: "low" },
    });
    expect(
      bedrockAdditionalFields(model("openai.gpt-oss-120b-1:0"), { reasoning: "xhigh" }, {}),
    ).toEqual({
      reasoning_effort: "high",
    });
  });

  it("sends only mapped flat efforts for other families, including off", () => {
    const kimi = model("moonshot.kimi-k3", { thinkingLevelMap: { off: "none", high: "high" } });
    expect(bedrockAdditionalFields(kimi, undefined, {})).toEqual({ reasoning_effort: "none" });
    expect(bedrockAdditionalFields(kimi, { reasoning: "high" }, {})).toEqual({
      reasoning_effort: "high",
    });
    expect(bedrockAdditionalFields(kimi, { reasoning: "low" }, {})).toBeUndefined();
    expect(
      bedrockAdditionalFields(model("amazon.nova-pro-v1:0"), { reasoning: "high" }, {}),
    ).toBeUndefined();
  });

  it("sends nothing for non-reasoning models", () => {
    expect(
      bedrockAdditionalFields(
        model("amazon.titan", { reasoning: false }),
        { reasoning: "high" },
        {},
      ),
    ).toBeUndefined();
  });
});
