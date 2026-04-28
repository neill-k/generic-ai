import { describe, expect, it, vi } from "vitest";
import {
  createGenericAILlmRuntime,
  createOpenAICodexRuntime,
  STOP_AND_RESPOND_TOOL_NAME,
} from "../../src/runtime/index.js";

interface FakeSessionOptions {
  readonly customTools?: readonly {
    readonly name?: string;
    readonly execute: (
      toolCallId: string,
      params: { readonly response: string },
    ) => Promise<unknown> | unknown;
  }[];
}

async function callStopTool(options: FakeSessionOptions, response: string) {
  const stopTool = options.customTools?.find(
    (tool) => tool.name === STOP_AND_RESPOND_TOOL_NAME,
  );
  if (stopTool === undefined) {
    throw new Error("Expected stop_and_respond tool to be registered.");
  }

  await stopTool.execute("stop-1", { response });
}

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
            find: () => ({ id: "gpt-5.5" }),
            hasConfiguredAuth: () => true,
          }),
          resourceLoaderFactory: () => ({
            reload: async () => undefined,
          }),
          createAgentSession: async (options) => {
            const sessionPrompt = vi.fn(async () => {
              await callStopTool(options as FakeSessionOptions, "hello from pi codex");
            });
            prompt.mockImplementation(sessionPrompt);
            return {
              session: {
                messages: [],
                prompt,
                dispose: vi.fn(),
              },
            } as never;
          },
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toEqual({
      adapter: "openai-codex",
      model: "gpt-5.5",
      outputText: "hello from pi codex",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai-codex", "test-key");
    expect(prompt.mock.calls[0]?.[0]).toContain("User task:\nping");
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining(STOP_AND_RESPOND_TOOL_NAME), {
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
        find: () => ({ id: "gpt-5.5" }),
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
          createAgentSession: async (options) =>
            ({
              session: {
                messages: [],
                prompt: vi.fn(async () => {
                  await callStopTool(options as FakeSessionOptions, "stored auth result");
                }),
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

  it("lets the Pi OpenAI Codex provider attempt OAuth auth even when auth preflight is conservative", async () => {
    const prompt = vi.fn(async () => undefined);
    const runtime = await createGenericAILlmRuntime(
      {},
      {
        openai: {
          authStorageFactory: () => ({
            setRuntimeApiKey: vi.fn(),
          }),
          modelRegistryFactory: () => ({
            find: () => ({ id: "gpt-5.5" }),
            hasConfiguredAuth: () => false,
          }),
          resourceLoaderFactory: () => ({
            reload: async () => undefined,
          }),
          createAgentSession: async (options) =>
            ({
              session: {
                messages: [],
                prompt: vi.fn(async (...args) => {
                  prompt(...args);
                  await callStopTool(options as FakeSessionOptions, "oauth auth result");
                }),
              },
            }) as never,
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toMatchObject({
      adapter: "openai-codex",
      outputText: "oauth auth result",
    });
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("User task:\nping"), {
      source: "extension",
    });
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
          find: () => ({ id: "gpt-5.5" }),
          hasConfiguredAuth: () => true,
        }),
        resourceLoaderFactory: () => ({
          reload: async () => undefined,
        }),
        createAgentSession: async (options) =>
          ({
            session: {
              messages: [],
              prompt: vi.fn(async () => {
                await callStopTool(options as FakeSessionOptions, "streamed pi result");
              }),
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
          model: "gpt-5.5",
          outputText: "streamed pi result",
        },
      },
    ]);
  });

  it("passes abort signals into Pi prompts and disposes aborted sessions", async () => {
    const controller = new AbortController();
    const dispose = vi.fn();
    let promptOptions: { readonly source?: string; readonly signal?: AbortSignal } | undefined;
    const prompt = vi.fn(
      async (_text: string, options?: { readonly source?: string; readonly signal?: AbortSignal }) => {
        promptOptions = options;
        queueMicrotask(() => controller.abort());
        await new Promise(() => undefined);
      },
    );
    const runtime = createOpenAICodexRuntime(
      {
        apiKey: "test-key",
      },
      {
        authStorageFactory: () => ({
          setRuntimeApiKey: vi.fn(),
        }),
        modelRegistryFactory: () => ({
          find: () => ({ id: "gpt-5.5" }),
          hasConfiguredAuth: () => true,
        }),
        resourceLoaderFactory: () => ({
          reload: async () => undefined,
        }),
        createAgentSession: async () =>
          ({
            session: {
              messages: [{ role: "assistant", content: "unused" }],
              prompt,
              dispose,
            },
          }) as never,
      },
    );

    await expect(runtime.run("abort please", { signal: controller.signal })).rejects.toThrow(
      "aborted during prompt dispatch",
    );
    expect(promptOptions).toMatchObject({
      source: "extension",
      signal: controller.signal,
    });
    expect(dispose).toHaveBeenCalled();
  });

  it("supports the explicit pi compatibility adapter", async () => {
    const setRuntimeApiKey = vi.fn();
    const prompt = vi.fn(async () => undefined);

    const runtime = await createGenericAILlmRuntime(
      {
        adapter: "pi",
        apiKey: "test-key",
        model: "gpt-5.5",
      },
      {
        pi: {
          authStorageFactory: () => ({
            setRuntimeApiKey,
          }),
          modelRegistryFactory: () => ({
            find: () => ({ id: "gpt-5.5" }),
          }),
          resourceLoaderFactory: () => ({
            reload: async () => undefined,
          }),
          createAgentSession: async (options) =>
            ({
              session: {
                messages: [],
                prompt: vi.fn(async (...args) => {
                  prompt(...args);
                  await callStopTool(options as FakeSessionOptions, "pi result");
                }),
              },
            }) as never,
        },
      },
    );

    await expect(runtime.run("ping")).resolves.toEqual({
      adapter: "pi",
      model: "gpt-5.5",
      outputText: "pi result",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-key");
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("User task:\nping"), {
      source: "extension",
    });
  });
});
