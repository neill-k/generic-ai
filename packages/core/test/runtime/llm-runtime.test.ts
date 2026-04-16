import { describe, expect, it, vi } from "vitest";
import {
  createGenericAILlmRuntime,
  createOpenAICodexRuntime,
} from "../../src/runtime/index.js";

describe("@generic-ai/core llm runtime adapter", () => {
  it("uses the OpenAI Codex adapter by default", async () => {
    const create = vi.fn(async () => ({
      output_text: "hello from openai",
      _request_id: "req_123",
    }));

    const runtime = await createGenericAILlmRuntime(
      {
        apiKey: "test-key",
        instructions: "Be terse.",
      },
      {
        openai: {
          client: {
            responses: {
              create,
            },
          },
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toEqual({
      adapter: "openai-codex",
      model: "gpt-5.2-codex",
      outputText: "hello from openai",
      requestId: "req_123",
    });
    expect(create).toHaveBeenCalledWith(
      {
        model: "gpt-5.2-codex",
        input: "ping",
        instructions: "Be terse.",
      },
      undefined,
    );
  });

  it("streams OpenAI delta events before the terminal response", async () => {
    async function* events() {
      yield {
        type: "response.output_text.delta",
        delta: "hello",
      };
      yield {
        type: "response.completed",
        response: {
          output_text: "hello",
          _request_id: "req_456",
        },
      };
    }

    const runtime = createOpenAICodexRuntime(
      {
        apiKey: "test-key",
      },
      {
        client: {
          responses: {
            create: vi.fn(async () => events()),
          },
        },
      },
    );

    const chunks = [];
    for await (const chunk of runtime.stream("stream please")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: "text-delta",
        delta: "hello",
      },
      {
        type: "response",
        response: {
          adapter: "openai-codex",
          model: "gpt-5.2-codex",
          outputText: "hello",
          requestId: "req_456",
        },
      },
    ]);
  });

  it("supports the explicit pi compatibility adapter", async () => {
    const setRuntimeApiKey = vi.fn();
    const prompt = vi.fn(async () => undefined);

    const runtime = await createGenericAILlmRuntime(
      {
        adapter: "pi",
        apiKey: "test-key",
        model: "gpt-5.2-codex",
      },
      {
        pi: {
          authStorageFactory: () => ({
            setRuntimeApiKey,
          }),
          modelRegistryFactory: () => ({
            find: () => ({ id: "gpt-5.2-codex" }),
          }),
          resourceLoaderFactory: () => ({
            reload: async () => undefined,
          }),
          createAgentSession: async () =>
            ({
              session: {
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "pi result" }],
                  },
                ],
                prompt,
              },
            }) as never,
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toEqual({
      adapter: "pi",
      model: "gpt-5.2-codex",
      outputText: "pi result",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(prompt).toHaveBeenCalledWith("ping", {
      source: "extension",
    });
  });
});
