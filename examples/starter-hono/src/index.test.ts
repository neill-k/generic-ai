import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CreateGenericAILlmRuntimeOptions,
  createAgentHarness,
  GenericAILlmRunResult,
  GenericAILlmRuntime,
} from "@generic-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStarterExampleFetch,
  createStarterExampleServer,
  loadStarterExampleEnvironment,
  STARTER_DEFAULT_START_DIR,
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
    adapter: "native",
    model: "gpt-5.5",
    run: async (input) =>
      ({
        adapter: "native",
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
          adapter: "native",
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

const FAKE_STARTER_TOKEN = "fake-starter-token-for-tests-only";

describe("@generic-ai/example-starter-hono", () => {
  it("creates a composed Hono app with real runtime wiring", async () => {
    const createRuntime = vi.fn(
      async (options: CreateGenericAILlmRuntimeOptions): Promise<GenericAILlmRuntime> => {
        expect(options.adapter).toBe("native");
        expect(options.apiKey).toBe("test-key");
        expect(options.model).toBe("gpt-5.5");
        expect(options.cwd).toContain(path.join("examples", "starter-hono"));
        expect(options.agentDir).toBeUndefined();
        expect(options.instructions).toContain("Break the user request into specialist work");
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
        adapter: "native",
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
          primaryAgent: "hierarchical-planner",
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
      adapter: "native",
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

  it("defaults to the native runtime and allows a missing provider key", () => {
    expect(loadStarterExampleEnvironment({})).toMatchObject({
      adapter: "native",
      exposure: "loopback",
    });
  });

  it("still accepts the OpenAI Codex adapter by name", () => {
    expect(
      loadStarterExampleEnvironment({ GENERIC_AI_RUNTIME_ADAPTER: "openai-codex" }),
    ).toMatchObject({ adapter: "openai-codex" });
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
        GENERIC_AI_AUTH_TOKEN: FAKE_STARTER_TOKEN,
        GENERIC_AI_AUTH_DB: ":memory:",
        GENERIC_AI_HOST: "0.0.0.0",
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      createRuntime: async () => createFakeRuntime("secured result"),
      log: () => undefined,
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
          authorization: `Bearer ${FAKE_STARTER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(authorized.status).toBe(200);
    } finally {
      await starter.stop();
    }
  });

  it("enables passkey owner auth with API tokens and stamps the actor on runs", async () => {
    const logs: string[] = [];
    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_PUBLIC_URL: "http://localhost:3000",
        GENERIC_AI_AUTH_DB: ":memory:",
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      createRuntime: async () => createFakeRuntime("owner result"),
      log: (message) => logs.push(message),
    });

    try {
      expect(starter.environment.auth.mode).toBe("owner");
      expect(starter.environment.auth.publicOrigin).toBe("http://localhost:3000");
      // No setup token was configured, so a one-time one is printed for the operator.
      expect(logs.join("\n")).toContain("/auth/login");

      const health = await starter.app.request("/starter/health");
      expect(await health.json()).toMatchObject({ auth: "owner", exposure: "loopback" });

      const page = await starter.fetch(
        new Request("http://localhost:3000/", { headers: { accept: "text/html" } }),
      );
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("/auth/login");

      const login = await starter.fetch(new Request("http://localhost:3000/auth/login"));
      expect(login.status).toBe(200);

      const anonymous = await starter.app.request("/starter/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(anonymous.status).toBe(401);

      const consoleAnonymous = await starter.fetch(
        localAppRequest("/console/api/config", { headers: { accept: "application/json" } }),
      );
      expect(consoleAnonymous.status).toBe(401);

      const auth = starter.auth?.auth;
      if (auth === undefined) {
        throw new Error("Expected owner auth to be enabled.");
      }
      const created = await auth.createApiToken({ name: "test", scopes: ["runs:execute"] });

      const run = await starter.app.request("/starter/run", {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(run.status).toBe(200);
      const payload = (await run.json()) as { result: { actor?: unknown } };
      expect(payload.result.actor).toEqual({
        subjectId: "owner",
        actorType: "human",
        credentialSource: "bearer",
        displayName: "Owner",
        credentialId: `token:${created.record.id}`,
      });
      expect(JSON.stringify(payload)).not.toContain(created.token);

      const stream = await starter.app.request("/starter/run/stream", {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(stream.status).toBe(200);
      const streamText = await stream.text();
      expect(streamText).toContain(`"credentialId": "token:${created.record.id}"`);
      expect(streamText).not.toContain(created.token);
    } finally {
      await starter.stop();
    }
  });

  it("refuses an auth database inside the agent workspace", async () => {
    await expect(
      createStarterExampleServer({
        env: {
          GENERIC_AI_OWNER_SETUP_TOKEN: "fake-setup-token-for-tests-only",
          GENERIC_AI_AUTH_DB: "./auth.sqlite",
          GENERIC_AI_PROVIDER_API_KEY: "test-key",
        },
        createRuntime: async () => createFakeRuntime("unused"),
        log: () => undefined,
      }),
    ).rejects.toThrow(/inside the agent workspace/);
  });

  it("rejects short auth secrets", () => {
    expect(() =>
      loadStarterExampleEnvironment({
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
        GENERIC_AI_AUTH_TOKEN: "short",
      }),
    ).toThrow(/at least 16 characters/);
  });

  it("records who started console chat runs", async () => {
    const startDir = await mkdtemp(path.join(tmpdir(), "generic-ai-console-actor-"));
    await cp(
      path.join(STARTER_DEFAULT_START_DIR, ".generic-ai"),
      path.join(startDir, ".generic-ai"),
      { recursive: true },
    );
    const harnessActors: unknown[] = [];
    const createHarness: typeof createAgentHarness = vi.fn((config) => ({
      config,
      adapter: {
        id: `${config.id}:fake`,
        kind: "pi",
        run: async () => {
          throw new Error("unused");
        },
      },
      run: async (input: HarnessRunInput) => {
        harnessActors.push(input.actor);
        return {
          harnessId: config.id,
          adapter: "pi",
          status: "succeeded",
          outputText: "done",
          envelope: {} as never,
          events: [],
          projections: [],
          artifacts: [],
          policyDecisions: [],
        };
      },
    })) as never;

    const starter = await createStarterExampleServer({
      env: {
        GENERIC_AI_OWNER_AUTH: "1",
        GENERIC_AI_AUTH_DB: ":memory:",
        GENERIC_AI_PROVIDER_API_KEY: "test-key",
      },
      startDir,
      createRuntime: async () => createFakeRuntime("runtime fallback"),
      createHarness,
      log: () => undefined,
    });

    try {
      const auth = starter.auth?.auth;
      if (auth === undefined) {
        throw new Error("Expected owner auth to be enabled.");
      }
      const created = await auth.createApiToken({ name: "console" });
      const headers = {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        "x-generic-ai-web-ui-token": starter.webUi.sessionToken,
      };
      const apply = await starter.app.request(
        localAppRequest("/console/api/templates/pipeline/apply", {
          method: "POST",
          headers,
          body: JSON.stringify({ dryRun: false, idempotencyKey: "console-actor-test" }),
        }),
      );
      expect(apply.status).toBe(200);

      const posted = await starter.app.request(
        localAppRequest("/console/api/chat/threads/actor/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "Who am I?" }),
        }),
      );
      expect(posted.status).toBe(200);
      const actor = {
        subjectId: "owner",
        actorType: "human",
        credentialSource: "bearer",
        displayName: "Owner",
        credentialId: `token:${created.record.id}`,
      };
      expect(harnessActors).toEqual([actor]);
      const detail = (await posted.json()) as {
        readonly messages: readonly { readonly role: string; readonly actor?: unknown }[];
        readonly events: readonly { readonly type: string; readonly data: { actor?: unknown } }[];
      };
      expect(detail.messages.find((message) => message.role === "user")?.actor).toEqual(actor);
      expect(detail.events.find((event) => event.type === "run.started")?.data.actor).toEqual(
        actor,
      );
      expect(JSON.stringify(detail)).not.toContain(created.token);
    } finally {
      await starter.stop();
      await rm(startDir, { recursive: true, force: true });
    }
  });

  it("stores owner auth in Postgres when DATABASE_URL is set", async () => {
    const databaseUrl = process.env["GENERIC_AI_TEST_POSTGRES_URL"];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      return;
    }
    const env = {
      GENERIC_AI_OWNER_AUTH: "1",
      DATABASE_URL: databaseUrl,
      GENERIC_AI_PROVIDER_API_KEY: "test-key",
    };
    expect(loadStarterExampleEnvironment(env).auth.store).toBe("postgres");

    const first = await createStarterExampleServer({
      env,
      createRuntime: async () => createFakeRuntime("pg"),
      log: () => undefined,
    });
    let token: string;
    try {
      const auth = first.auth?.auth;
      if (auth === undefined) {
        throw new Error("Expected owner auth to be enabled.");
      }
      token = (await auth.createApiToken({ name: `pg-${Date.now()}` })).token;
    } finally {
      await first.stop();
    }

    // A fresh server (as after a redeploy) still accepts the token.
    const second = await createStarterExampleServer({
      env,
      createRuntime: async () => createFakeRuntime("pg"),
      log: () => undefined,
    });
    try {
      const run = await second.app.request("/starter/run", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      });
      expect(run.status).toBe(200);
    } finally {
      await second.stop();
    }
  });
});
