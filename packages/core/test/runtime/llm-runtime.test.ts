import { describe, expect, it, vi } from "vitest";
import { createGenericAILlmRuntime, createOpenAICodexRuntime } from "../../src/runtime/index.js";

describe("@generic-ai/core llm runtime adapter", () => {
  it("uses Pi's OpenAI Codex provider path by default", async () => {
    const setRuntimeApiKey = vi.fn();
    const prompt = vi.fn(async () => undefined);

    const runtime = await createGenericAILlmRuntime(
      {
        apiKey: "test-key",
        instructions: "Be terse.",
      },
      {
        openai: {
          authStorageFactory: () => ({
            setRuntimeApiKey,
          }),
          modelRegistryFactory: () => ({
            find: () => ({ id: "gpt-5.2-codex" }),
            hasConfiguredAuth: () => true,
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
                    content: [{ type: "text", text: "hello from pi codex" }],
                  },
                ],
                prompt,
                dispose: vi.fn(),
              },
            }) as never,
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toEqual({
      adapter: "openai-codex",
      model: "gpt-5.2-codex",
      outputText: "hello from pi codex",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai-codex", "test-key");
    expect(prompt).toHaveBeenCalledWith("ping", {
      source: "extension",
    });
  });

  it("supports OpenAI Codex auth from Pi agent storage without an API key", async () => {
    const setRuntimeApiKey = vi.fn();
    const authStorageFactory = vi.fn((agentDir?: string) => {
      expect(agentDir).toBeTypeOf("string");
      return {
        setRuntimeApiKey,
      };
    });
    const modelRegistryFactory = vi.fn((_authStorage: unknown, agentDir?: string) => {
      expect(agentDir).toBeTypeOf("string");
      return {
        find: () => ({ id: "gpt-5.2-codex" }),
        hasConfiguredAuth: () => true,
      };
    });
    const resourceLoaderFactory = vi.fn(
      (options: { readonly cwd?: string; readonly agentDir?: string }) => {
        expect(options.cwd).toBeTypeOf("string");
        expect(options.agentDir).toBeTypeOf("string");
        return {
          reload: async () => undefined,
        };
      },
    );

    const runtime = await createGenericAILlmRuntime(
      {},
      {
        openai: {
          authStorageFactory,
          modelRegistryFactory,
          resourceLoaderFactory,
          createAgentSession: async () =>
            ({
              session: {
                messages: [{ role: "assistant", content: "stored auth result" }],
                prompt: vi.fn(async () => undefined),
              },
            }) as never,
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toMatchObject({
      adapter: "openai-codex",
      outputText: "stored auth result",
    });
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
    expect(authStorageFactory).toHaveBeenCalled();
    expect(modelRegistryFactory).toHaveBeenCalled();
    expect(resourceLoaderFactory).toHaveBeenCalled();
  });

  it("streams a terminal response from the Pi OpenAI Codex path", async () => {
    const runtime = createOpenAICodexRuntime(
      {
        apiKey: "test-key",
      },
      {
        authStorageFactory: () => ({
          setRuntimeApiKey: vi.fn(),
        }),
        modelRegistryFactory: () => ({
          find: () => ({ id: "gpt-5.2-codex" }),
          hasConfiguredAuth: () => true,
        }),
        resourceLoaderFactory: () => ({
          reload: async () => undefined,
        }),
        createAgentSession: async () =>
          ({
            session: {
              messages: [{ role: "assistant", content: "streamed pi result" }],
              prompt: vi.fn(async () => undefined),
            },
          }) as never,
      },
    );

    const chunks = [];
    const stream = runtime.stream;
    for await (const chunk of stream("stream please")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        type: "response",
        response: {
          adapter: "openai-codex",
          model: "gpt-5.2-codex",
          outputText: "streamed pi result",
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
