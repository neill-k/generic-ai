import { describe, expect, it } from "vitest";
import {
  type Context,
  complete,
  extractCodexAccountId,
  githubCopilotApi,
  githubCopilotRequestHeaders,
  resolveCodexClientBaseUrl,
  resolveModel,
  type StreamOptions,
} from "../src/index.js";

/**
 * The ChatGPT Codex backend and GitHub Copilot, driven through the SDKs with a `fetch` that records
 * the request and replays a recorded event stream. No network, no keys, no model calls.
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

function replay(body: string, record: Recorded[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    record.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const responsesStream = sse([
  {
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
  },
  {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "Hi",
    },
  },
  {
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi" }],
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
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  },
]);

const messagesStream = sse([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
  },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
]);

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const codexToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });

const context: Context = {
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: "Say hi", timestamp: 1 }],
};

describe("openai-codex provider (ChatGPT Plus/Pro)", () => {
  const model = resolveModel("openai-codex/gpt-5.5");

  it("resolves to the Codex backend", () => {
    expect(model.api).toBe("openai-codex-responses");
    expect(model.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(model.reasoning).toBe(true);
  });

  it("normalizes the base URL the way pi does", () => {
    expect(resolveCodexClientBaseUrl(undefined)).toBe("https://chatgpt.com/backend-api/codex");
    expect(resolveCodexClientBaseUrl("https://chatgpt.com/backend-api/")).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(resolveCodexClientBaseUrl("https://proxy.test/codex")).toBe("https://proxy.test/codex");
    expect(resolveCodexClientBaseUrl("https://proxy.test/codex/responses")).toBe(
      "https://proxy.test/codex",
    );
  });

  it("reads the account id from the access token", () => {
    expect(extractCodexAccountId(codexToken)).toBe("acct_123");
    expect(extractCodexAccountId("not-a-jwt")).toBeUndefined();
    expect(extractCodexAccountId(fakeJwt({}))).toBeUndefined();
  });

  it("posts a stateless request with the system prompt as a developer item", async () => {
    const recorded: Recorded[] = [];
    const options: StreamOptions = {
      apiKey: codexToken,
      maxRetries: 0,
      sessionId: "s1",
      reasoning: "low",
      fetch: replay(responsesStream, recorded),
    };
    const message = await complete(model, context, options);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "Hi" })]);

    const request = recorded[0];
    expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${codexToken}`);
    expect(request?.headers.get("chatgpt-account-id")).toBe("acct_123");
    expect(request?.headers.get("openai-beta")).toBe("responses=experimental");
    expect(request?.headers.get("originator")).toBe("generic-ai");
    expect(request?.headers.get("session-id")).toBe("s1");

    const body = request?.body ?? {};
    expect(body["instructions"]).toBeUndefined();
    expect(body["store"]).toBe(false);
    expect(body["stream"]).toBe(true);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["prompt_cache_key"]).toBe("s1");
    expect(body["tool_choice"]).toBe("auto");
    expect(body["parallel_tool_calls"]).toBe(true);
    expect(body["reasoning"]).toEqual({ effort: "low", summary: "auto" });
    const input = body["input"] as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "Be brief." }],
    });
    expect(input[1]).toMatchObject({ role: "user" });
  });

  it("uses an account id header from the sign-in instead of decoding the token", async () => {
    const recorded: Recorded[] = [];
    await complete(model, context, {
      apiKey: "opaque-token",
      headers: { "chatgpt-account-id": "acct_from_auth", originator: "my-app" },
      maxRetries: 0,
      fetch: replay(responsesStream, recorded),
    });
    expect(recorded[0]?.headers.get("chatgpt-account-id")).toBe("acct_from_auth");
    expect(recorded[0]?.headers.get("originator")).toBe("my-app");
  });

  it("fails clearly without a sign-in", async () => {
    const message = await complete(model, context, { maxRetries: 0 });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("openaiCodexOAuth");
  });
});

describe("github-copilot provider", () => {
  it("routes each model to the API Copilot serves it on", () => {
    expect(githubCopilotApi("claude-sonnet-5")).toBe("anthropic-messages");
    expect(githubCopilotApi("claude-opus-4.8")).toBe("anthropic-messages");
    expect(githubCopilotApi("gpt-5.5")).toBe("openai-responses");
    expect(githubCopilotApi("grok-code-fast-1")).toBe("openai-responses");
    expect(githubCopilotApi("gemini-3-pro")).toBe("openai-completions");
    expect(resolveModel("github-copilot/claude-sonnet-5").api).toBe("anthropic-messages");
    expect(resolveModel("github-copilot/gpt-5.5").baseUrl).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });

  it("marks agent follow-ups and image requests", () => {
    expect(githubCopilotRequestHeaders(context)).toEqual({
      "X-Initiator": "user",
      "Openai-Intent": "conversation-edits",
    });
    const followUp = githubCopilotRequestHeaders({
      messages: [
        ...context.messages,
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "look",
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(followUp["X-Initiator"]).toBe("agent");
    expect(followUp["Copilot-Vision-Request"]).toBe("true");
  });

  it("sends Claude models to the account endpoint with bearer auth and Copilot headers", async () => {
    const recorded: Recorded[] = [];
    const model = resolveModel("github-copilot/claude-sonnet-5", {
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const message = await complete(model, context, {
      apiKey: "copilot-token",
      headers: { "Editor-Version": "vscode/1.107.0" },
      maxRetries: 0,
      fetch: replay(messagesStream, recorded),
    });
    expect(message.stopReason).toBe("stop");
    const request = recorded[0];
    expect(request?.url).toBe("https://api.enterprise.githubcopilot.com/v1/messages");
    expect(request?.headers.get("authorization")).toBe("Bearer copilot-token");
    expect(request?.headers.get("x-api-key")).toBeNull();
    expect(request?.headers.get("x-initiator")).toBe("user");
    expect(request?.headers.get("openai-intent")).toBe("conversation-edits");
    expect(request?.headers.get("editor-version")).toBe("vscode/1.107.0");
  });

  it("sends GPT models to /responses", async () => {
    const recorded: Recorded[] = [];
    await complete(resolveModel("github-copilot/gpt-5.5"), context, {
      apiKey: "copilot-token",
      maxRetries: 0,
      fetch: replay(responsesStream, recorded),
    });
    expect(recorded[0]?.url).toBe("https://api.individual.githubcopilot.com/responses");
    expect(recorded[0]?.headers.get("authorization")).toBe("Bearer copilot-token");
    expect(recorded[0]?.headers.get("x-initiator")).toBe("user");
  });
});
