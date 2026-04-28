import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  createAgentHarness,
  CreateGenericAILlmRuntimeOptions,
  GenericAILlmRuntime,
  GenericAILlmRunResult,
} from "@generic-ai/core";
import {
  STARTER_DEFAULT_START_DIR,
  createStarterExampleFetch,
  createStarterExampleServer,
  loadStarterExampleEnvironment,
} from "./index.ts";
import { startFetchServer } from "./node-server.ts";
import { runStarterExampleCli } from "./run.ts";

const openServers: Array<() => Promise<void>> = [];
type HarnessRunInput = Parameters<ReturnType<typeof createAgentHarness>["run"]>[0];
const TRUSTED_PEER_ADDRESS_SYMBOL = Symbol.for("@generic-ai/http.peerAddress");

function localAppRequest(pathname: string, init?: RequestInit): Request {
  const request = new Request(`http://localhost${pathname}`, init);
  Object.defineProperty(request, TRUSTED_PEER_ADDRESS_SYMBOL, {
    enumerable: false,
    value: "127.0.0.1",
  });
  return request;
}

function createFakeRuntime(outputText: string): GenericAILlmRuntime {
  return {
    adapter: "openai-codex",
    model: "gpt-5.5",
    run: async (input) =>
      ({
        adapter: "openai-codex",
        model: "gpt-5.5",
        outputText: `${outputText}: ${input}`,
      }) satisfies GenericAILlmRunResult,
    stream: async function* (input) {
      yield {
        type: "event",
        event: {
          name: "pi.turn_start",
          data: {
            type: "turn_start",
          },
        },
      };
      yield {
        type: "event",
        event: {
          name: "pi.tool_execution_start",
          data: {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "workspace_read",
          },
        },
      };
      yield {
        type: "event",
        event: {
          name: "pi.tool_execution_end",
          data: {
            type: "tool_execution_end",
            isError: false,
            toolCallId: "call-1",
            toolName: "workspace_read",
          },
        },
      };
      yield {
        type: "response",
        response: {
          adapter: "openai-codex",
          model: "gpt-5.5",
          outputText: `${outputText}: ${input}`,
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
        expect(options.model).toBe("gpt-5.5");
        expect(options.cwd).toContain(path.join("examples", "starter-hono"));
        expect(options.agentDir).toBeUndefined();
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
        model: "gpt-5.5",
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

      const consoleHealth = await starter.app.request(localAppRequest("/console/api/health"));
      expect(consoleHealth.status).toBe(200);
      expect(await consoleHealth.json()).toMatchObject({
        plugin: "@generic-ai/plugin-web-ui",
        config: {
          ok: true,
          primaryAgent: "starter",
        },
      });
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
      expect(streamedText).toContain("event: pi.tool_execution_start");
      expect(streamedText).toContain("workspace_read");
      expect(streamedText).toContain("event: run.completed");
      expect(streamedText).toContain("event: run.envelope");
      expect(streamedText).toContain("streamed result: stream me");
    } finally {
      await starter.stop();
    }
  });

  it("routes console chat through the applied harness instead of echoing the user message", async () => {
    const startDir = await mkdtemp(path.join(tmpdir(), "generic-ai-console-harness-"));
    await cp(
      path.join(STARTER_DEFAULT_START_DIR, ".generic-ai"),
      path.join(startDir, ".generic-ai"),
      { recursive: true },
    );
    const harnessInstructions: string[] = [];
    const harnessToolNames: string[][] = [];
    const harnessWorkspaceRoots: string[] = [];
    const createHarness: typeof createAgentHarness = vi.fn((config) => {
      return {
        config,
        adapter: {
          id: `${config.id}:fake`,
          kind: "pi",
          run: async () => {
            throw new Error("The fake adapter should not be called directly.");
          },
        },
        run: async (input: HarnessRunInput) => {
          harnessInstructions.push(input.instruction);
          harnessWorkspaceRoots.push(input.workspaceRoot);
          harnessToolNames.push(
            input.capabilities?.fileTools?.piTools.map((tool) => tool.name).sort() ?? [],
          );
          return {
            harnessId: config.id,
            adapter: "pi",
            status: "succeeded",
            outputText: "harness actually ran through pipeline",
            envelope: {} as never,
            events: [],
            projections: [],
            artifacts: [],
            policyDecisions: [],
          };
        },
      };
    }) as never;

    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      startDir,
      createRuntime: async () => createFakeRuntime("runtime fallback"),
      createHarness,
    });

    try {
      const token = starter.webUi.sessionToken;
      const apply = await starter.app.request(
        localAppRequest("/console/api/templates/pipeline/apply", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-generic-ai-web-ui-token": token,
          },
          body: JSON.stringify({
            dryRun: false,
            idempotencyKey: "pipeline-console-chat-test",
          }),
        }),
      );
      expect(apply.status).toBe(200);
      expect(await apply.json()).toMatchObject({ ok: true });

      const posted = await starter.app.request(
        localAppRequest("/console/api/chat/threads/demo/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-generic-ai-web-ui-token": token,
          },
          body: JSON.stringify({ content: "Do actual work" }),
        }),
      );

      expect(posted.status).toBe(200);
      const detail = (await posted.json()) as {
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      };
      expect(detail.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Do actual work" }),
          expect.objectContaining({
            role: "assistant",
            content: "harness actually ran through pipeline",
          }),
        ]),
      );
      expect(detail.messages.some((message) => message.content === "echo: Do actual work")).toBe(
        false,
      );
      expect(createHarness).toHaveBeenCalledOnce();
      expect(harnessWorkspaceRoots[0]).toBe(startDir);
      expect(harnessToolNames[0]).toEqual(["find", "grep", "ls", "read"]);
      expect(harnessInstructions[0]).toContain("Selected harness id: pipeline");
      expect(harnessInstructions[0]).toContain("Selected agent id: pipeline-intake");
      expect(harnessInstructions[0]).toContain("User task:\nDo actual work");
    } finally {
      await starter.stop();
      await rm(startDir, { force: true, recursive: true });
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
      model: "gpt-5.5",
      streaming: true,
    });

    const streamed = await fetch(
      `http://${started.server.host}:${started.server.port}/starter/run/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "from browser" }),
      },
    );
    const streamedText = await streamed.text();

    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(streamedText).toContain("event: run.envelope");
    expect(streamedText).toContain("network result: from browser");
  });

  it("stamps fetch requests with trusted peer socket metadata", async () => {
    let peerAddress: unknown;
    const started = await startFetchServer(
      (request) => {
        peerAddress = Reflect.get(request, TRUSTED_PEER_ADDRESS_SYMBOL);
        return new Response("ok");
      },
      { host: "127.0.0.1", port: 0 },
    );
    openServers.push(started.close);

    const response = await fetch(`http://${started.host}:${started.port}/`, {
      headers: { host: "localhost" },
    });

    expect(response.status).toBe(200);
    expect(String(peerAddress)).toContain("127.0.0.1");
  });

  it("serves the built playground shell before falling back to starter routes", async () => {
    const publicDir = await mkdtemp(path.join(tmpdir(), "generic-ai-starter-ui-"));

    try {
      await mkdir(path.join(publicDir, "assets"));
      await writeFile(
        path.join(publicDir, "index.html"),
        "<!doctype html><title>Playground</title>",
      );
      await writeFile(path.join(publicDir, "assets", "app.js"), "console.log('ok');");

      const transportFetch = vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        return new Response(`transport:${url.pathname}`, { status: 404 });
      });
      const fetchHandler = createStarterExampleFetch(transportFetch, { publicDir });

      const root = await fetchHandler(new Request("http://starter.test/"));
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type")).toContain("text/html");
      expect(await root.text()).toContain("Playground");

      const asset = await fetchHandler(new Request("http://starter.test/assets/app.js"));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");

      const api = await fetchHandler(new Request("http://starter.test/starter/health"));
      expect(api.status).toBe(404);
      expect(await api.text()).toBe("transport:/starter/health");
      const consoleApi = await fetchHandler(new Request("http://starter.test/console/api/health"));
      expect(consoleApi.status).toBe(404);
      expect(await consoleApi.text()).toBe("transport:/console/api/health");
      expect(transportFetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(publicDir, { force: true, recursive: true });
    }
  });

  it("allows missing provider keys so Pi-managed OpenAI Codex auth can be used", () => {
    expect(loadStarterExampleEnvironment({})).toMatchObject({
      adapter: "openai-codex",
      exposure: "loopback",
    });
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
