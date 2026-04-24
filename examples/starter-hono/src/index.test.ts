import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateGenericAILlmRuntimeOptions,
  GenericAILlmRuntime,
  GenericAILlmRunResult,
} from "@generic-ai/core";
import { createStarterExampleServer, loadStarterExampleEnvironment } from "./index.js";
import { runStarterExampleCli } from "./run.js";

const openServers: Array<() => Promise<void>> = [];

function createFakeRuntime(outputText: string): GenericAILlmRuntime {
  return {
    adapter: "openai-codex",
    model: "gpt-5.2-codex",
    run: async (input) =>
      ({
        adapter: "openai-codex",
        model: "gpt-5.2-codex",
        outputText: `${outputText}: ${input}`,
      }) satisfies GenericAILlmRunResult,
    stream: async function* () {
      yield {
        type: "response",
        response: {
          adapter: "openai-codex",
          model: "gpt-5.2-codex",
          outputText,
        },
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()));
});

describe("@generic-ai/example-starter-hono", () => {
  it("creates a composed Hono app with real runtime wiring", async () => {
    const createRuntime = vi.fn(
      async (options: CreateGenericAILlmRuntimeOptions): Promise<GenericAILlmRuntime> => {
        expect(options.adapter).toBe("openai-codex");
        expect(options.apiKey).toBe("test-key");
        expect(options.model).toBe("gpt-5.2-codex");
        expect(options.cwd).toContain(path.join("examples", "starter-hono"));
        expect(options.instructions).toContain("Generic AI starter example agent");
        return createFakeRuntime("runtime result");
      },
    );

    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      createRuntime,
    });

    try {
      const health = await starter.app.request("/starter/health");
      const healthPayload = (await health.json()) as Record<string, unknown>;
      expect(healthPayload).toMatchObject({
        adapter: "openai-codex",
        exposure: "loopback",
        model: "gpt-5.2-codex",
        streaming: true,
        transport: "@generic-ai/plugin-hono",
      });
      expect(healthPayload).not.toHaveProperty("workspaceRoot");
      expect(healthPayload).not.toHaveProperty("bootstrap");

      const run = await starter.app.request("/starter/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: "hello runtime",
        }),
      });
      const payload = (await run.json()) as {
        result: {
          status: string;
          output?: {
            payload?: {
              outputText?: string;
            };
          };
        };
      };

      expect(payload.result.status).toBe("succeeded");
      expect(payload.result.output?.payload?.outputText).toBe("runtime result: hello runtime");
      expect(createRuntime).toHaveBeenCalledOnce();
    } finally {
      await starter.stop();
    }
  });

  it("streams lifecycle events and a terminal run envelope", async () => {
    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      createRuntime: async () => createFakeRuntime("streamed result"),
    });

    try {
      const streamed = await starter.app.request("/starter/run/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: "stream me",
        }),
      });
      const streamedText = await streamed.text();

      expect(streamedText).toContain("event: run.created");
      expect(streamedText).toContain("event: run.started");
      expect(streamedText).toContain("event: run.completed");
      expect(streamedText).toContain("event: run.envelope");
      expect(streamedText).toContain("streamed result: stream me");
    } finally {
      await starter.stop();
    }
  });

  it("starts the real node server entrypoint", async () => {
    const started = await runStarterExampleCli({
      env: {
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_PORT: "0",
      },
      log: () => undefined,
      createRuntime: async () => createFakeRuntime("network result"),
    });
    openServers.push(started.close);

    const health = await fetch(
      `http://${started.server.host}:${started.server.port}/starter/health`,
    );
    expect(await health.json()).toMatchObject({
      adapter: "openai-codex",
      model: "gpt-5.2-codex",
      streaming: true,
    });
  });

  it("fails fast when the provider key is missing", () => {
    expect(() => loadStarterExampleEnvironment({})).toThrow(
      "GENERIC_AI_PROVIDER_API_KEY must be set",
    );
  });

  it("fails fast when configured for unauthenticated non-loopback exposure", () => {
    expect(() =>
      loadStarterExampleEnvironment({
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_HOST: "0.0.0.0",
      }),
    ).toThrow("GENERIC_AI_UNSAFE_EXPOSE=1");
  });

  it("loads a deliberate unsafe non-loopback exposure", () => {
    expect(
      loadStarterExampleEnvironment({
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_HOST: "0.0.0.0",
        GENERIC_AI_UNSAFE_EXPOSE: "1",
      }),
    ).toMatchObject({
      exposure: "unsafe-remote",
      host: "0.0.0.0",
      unsafeExpose: true,
    });
  });

  it("normalizes IPv6 loopback bind hosts before exposure checks", () => {
    expect(
      loadStarterExampleEnvironment({
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_HOST: "[::1]",
      }),
    ).toMatchObject({
      exposure: "loopback",
      host: "::1",
    });

    expect(
      loadStarterExampleEnvironment({
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_HOST: "0:0:0:0:0:0:0:1",
      }),
    ).toMatchObject({
      exposure: "loopback",
      host: "0:0:0:0:0:0:0:1",
    });
  });

  it("requires the configured bearer token for run endpoints", async () => {
    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_AUTH_TOKEN: "test-token",
        GENERIC_AI_HOST: "0.0.0.0",
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      createRuntime: async () => createFakeRuntime("secured result"),
    });

    try {
      const health = await starter.app.request("/starter/health");
      expect(await health.json()).toMatchObject({
        exposure: "authenticated-remote",
      });

      const unauthorized = await starter.app.request("/starter/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await starter.app.request("/starter/run", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(authorized.status).toBe(200);
    } finally {
      await starter.stop();
    }
  });
});
