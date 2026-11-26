import { describe, expect, it } from "vitest";
import {
  type AssistantMessage,
  emptyUsage,
  MISSING_TOOL_RESULT_TEXT,
  type Message,
  parseModelRef,
  resolveModel,
  sanitizeToolCallId,
  transformMessages,
} from "../src/index.js";

const claude = resolveModel("anthropic/claude-opus-5-5");
const textOnly = resolveModel("openrouter/text-only", { input: ["text"] });

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: claude.api,
    provider: claude.provider,
    model: claude.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

describe("transformMessages", () => {
  it("replaces images with placeholders for text-only models", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
        timestamp: 1,
      },
    ];
    const [user] = transformMessages(messages, textOnly);
    expect(JSON.stringify(user)).not.toContain("AAAA");
    expect(transformMessages(messages, claude)).toEqual(messages);
  });

  it("keeps same-model thinking and drops thinking from another model", () => {
    const own = assistant([
      { type: "thinking", thinking: "t", thinkingSignature: "sig" },
      { type: "text", text: "a" },
    ]);
    const foreign = { ...own, model: "other-model" };
    expect(transformMessages([own], claude)[0]).toEqual(own);
    expect((transformMessages([foreign], claude)[0] as AssistantMessage).content).toEqual([
      { type: "text", text: "a" },
    ]);
  });

  it("drops empty unsigned thinking", () => {
    const message = assistant([
      { type: "thinking", thinking: "  " },
      { type: "text", text: "a" },
    ]);
    expect((transformMessages([message], claude)[0] as AssistantMessage).content).toEqual([
      { type: "text", text: "a" },
    ]);
  });

  it("skips errored and aborted assistant turns", () => {
    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: 1 },
      assistant([{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: "boom" }),
      assistant([{ type: "text", text: "partial" }], { stopReason: "aborted" }),
      { role: "user", content: "again", timestamp: 2 },
    ];
    expect(transformMessages(messages, claude).map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
  });

  it("adds an error result for tool calls that never got one", () => {
    const messages: Message[] = [
      assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], {
        stopReason: "toolUse",
      }),
      { role: "user", content: "interrupt", timestamp: 2 },
    ];
    const result = transformMessages(messages, claude);
    expect(result.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
  });

  it("rewrites foreign tool-call ids and their results together", () => {
    const messages: Message[] = [
      assistant([{ type: "toolCall", id: "call|item", name: "read", arguments: {} }], {
        stopReason: "toolUse",
        model: "gpt-5.5",
        provider: "openai",
        api: "openai-responses",
      }),
      {
        role: "toolResult",
        toolCallId: "call|item",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: 2,
      },
    ];
    const result = transformMessages(messages, claude, (id) => sanitizeToolCallId(id));
    const call = (result[0] as AssistantMessage).content[0];
    expect(call?.type === "toolCall" ? call.id : "").toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(result[1]).toMatchObject({ toolCallId: call?.type === "toolCall" ? call.id : "" });
  });
});

describe("sanitizeToolCallId", () => {
  it("leaves valid ids unchanged and keeps distinct ids distinct", () => {
    expect(sanitizeToolCallId("toolu_123")).toBe("toolu_123");
    const a = sanitizeToolCallId("call|a");
    const b = sanitizeToolCallId("call|b");
    expect(a).not.toBe(b);
    expect(sanitizeToolCallId("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe("model references", () => {
  it("parses provider/id refs, including ids with slashes", () => {
    expect(parseModelRef("anthropic/claude-opus-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
    });
    expect(parseModelRef("openrouter/qwen/qwen3-coder")).toEqual({
      provider: "openrouter",
      id: "qwen/qwen3-coder",
    });
  });

  it("resolves catalog models, unknown ids for known providers, and overrides", () => {
    expect(resolveModel("anthropic/claude-opus-5-5")).toMatchObject({
      api: "anthropic-messages",
      thinkingMode: "adaptive",
    });
    expect(resolveModel("openai/new-model")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(resolveModel("anthropic/claude-opus-5-5", { baseUrl: "http://proxy" }).baseUrl).toBe(
      "http://proxy",
    );
    expect(() => resolveModel("nowhere/model")).toThrow(/Unknown provider/);
    expect(
      resolveModel("local/model", {
        api: "openai-completions",
        baseUrl: "http://localhost:8080/v1",
      }).provider,
    ).toBe("local");
  });
});
