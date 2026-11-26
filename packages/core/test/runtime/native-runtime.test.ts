import {
  type AssistantMessage,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGenericAILlmRuntime,
  type GenericAILlmStreamChunk,
  resolveNativeModel,
  STOP_AND_RESPOND_TOOL_NAME,
} from "../../src/runtime/index.js";

const registrations: FauxProviderRegistration[] = [];

function faux(): FauxProviderRegistration {
  const registration = registerFauxProvider();
  registrations.push(registration);
  return registration;
}

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function stopCall(response: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(STOP_AND_RESPOND_TOOL_NAME, { response })], {
    stopReason: "toolUse",
  });
}

describe("native runtime adapter", () => {
  it("runs the stop-tool loop until stop_and_respond is called", async () => {
    const provider = faux();
    provider.setResponses([fauxAssistantMessage("still working"), stopCall("All done.")]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native", instructions: "You are a test agent." },
      { native: { model: provider.getModel() } },
    );

    const result = await runtime.run("Do the task");

    expect(result).toEqual({ adapter: "native", model: "faux/faux-1", outputText: "All done." });
    expect(runtime.adapter).toBe("native");
    expect(runtime.instructions).toBe("You are a test agent.");
    // One request for the plain reply, one for the stop call after the continuation prompt.
    expect(provider.state.callCount).toBe(2);
  });

  it("passes the system prompt and the stop tool to the provider", async () => {
    const provider = faux();
    let seen: { systemPrompt?: string; tools?: string[] } = {};
    provider.setResponses([
      (context) => {
        seen = {
          ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
          tools: (context.tools ?? []).map((tool) => tool.name),
        };
        return stopCall("ok");
      },
    ]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native", instructions: "Be precise." },
      { native: { model: provider.getModel() } },
    );
    await runtime.run("hi");
    expect(seen).toEqual({ systemPrompt: "Be precise.", tools: [STOP_AND_RESPOND_TOOL_NAME] });
  });

  it("returns the first reply in single-turn mode", async () => {
    const provider = faux();
    provider.setResponses([fauxAssistantMessage("Hello there", { responseId: "resp-1" })]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native", turnMode: "single-turn" },
      { native: { model: provider.getModel() } },
    );
    const result = await runtime.run("hi");
    expect(result.outputText).toBe("Hello there");
    expect(result.requestId).toBe("resp-1");
  });

  it("fails when maxTurns is reached without the stop tool", async () => {
    const provider = faux();
    provider.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native", maxTurns: 2 },
      { native: { model: provider.getModel() } },
    );
    await expect(runtime.run("hi")).rejects.toThrow(
      `${STOP_AND_RESPOND_TOOL_NAME} was not called after 2 turn(s).`,
    );
  });

  it("surfaces provider errors", async () => {
    const provider = faux();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" }),
    ]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native", turnMode: "single-turn" },
      { native: { model: provider.getModel() } },
    );
    await expect(runtime.run("hi")).rejects.toThrow("rate limited");
  });

  it("streams text deltas, tool events, then the response", async () => {
    const provider = faux();
    provider.setResponses([fauxAssistantMessage("thinking out loud"), stopCall("Final.")]);
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native" },
      { native: { model: provider.getModel() } },
    );
    const chunks: GenericAILlmStreamChunk[] = [];
    for await (const chunk of runtime.stream("go")) {
      chunks.push(chunk);
    }
    const text = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => (chunk.type === "text-delta" ? chunk.delta : ""))
      .join("");
    expect(text).toBe("thinking out loud");
    expect(
      chunks.some((chunk) => chunk.type === "event" && chunk.event.name === "tool_execution_end"),
    ).toBe(true);
    expect(chunks.at(-1)).toEqual({
      type: "response",
      response: { adapter: "native", model: "faux/faux-1", outputText: "Final." },
    });
  });

  it("rejects a run whose signal is already aborted", async () => {
    const provider = faux();
    const runtime = await createGenericAILlmRuntime(
      { adapter: "native" },
      { native: { model: provider.getModel() } },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run("hi", { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(provider.state.callCount).toBe(0);
  });
});

describe("resolveNativeModel", () => {
  it("resolves provider/model refs and bare ids", () => {
    expect(resolveNativeModel("anthropic/claude-sonnet-5-5")).toMatchObject({
      provider: "anthropic",
      api: "anthropic-messages",
    });
    expect(resolveNativeModel("claude-opus-5-5")).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-5-5",
    });
    expect(resolveNativeModel("gpt-5.5")).toMatchObject({
      provider: "openai",
      api: "openai-responses",
    });
    expect(resolveNativeModel("openrouter/qwen/qwen3-coder")).toMatchObject({
      provider: "openrouter",
      id: "qwen/qwen3-coder",
    });
  });
});
