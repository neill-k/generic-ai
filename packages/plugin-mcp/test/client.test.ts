import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GenericAIToolError, getAgentHarnessToolEffects } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMcpClientManager,
  createMcpHarnessTools,
  createMcpPlugin,
  type McpClientEvent,
  type McpClientManager,
  McpClientError,
  type McpHarnessTool,
  type McpServerDefinition,
  mcpHarnessToolName,
} from "../src/index.js";
// @ts-expect-error -- plain ESM fixture without type declarations
import { startHttpFixture } from "./fixtures/fixture-server.mjs";

interface HttpFixture {
  readonly url: string;
  readonly port: number;
  readonly instanceId: string;
  close(): Promise<void>;
}

const startHttp = startHttpFixture as (options?: {
  port?: number;
  instanceId?: string;
}) => Promise<HttpFixture>;

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fixture-server.mjs");

const stdioServer = (overrides: Partial<McpServerDefinition> = {}): McpServerDefinition => ({
  id: "fixture",
  transport: "stdio",
  command: process.execPath,
  args: [fixturePath, "stdio"],
  ...overrides,
});

// Config placeholders use shell-style `${VAR}` syntax, so tests build them without template strings.
const placeholder = (variable: string): string => ["$", "{", variable, "}"].join("");

const fastReconnect = { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 50 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function track<T extends { close(): Promise<void> }>(value: T): T {
  cleanups.push(() => value.close());
  return value;
}

function textOf(result: { readonly content: readonly { readonly text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

function toolNamed(tools: readonly McpHarnessTool[], name: string): McpHarnessTool {
  const tool = tools.find((candidate) => candidate.mcp.toolName === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe("MCP client over stdio", () => {
  it("connects, lists tools and exposes them as harness tools with effects", async () => {
    const manager = track(createMcpClientManager({ servers: [stdioServer()] }));
    const statuses = await manager.connect();
    expect(statuses[0]).toMatchObject({ id: "fixture", state: "connected", connectCount: 1 });
    expect(statuses[0]?.serverName).toBe("generic-ai-fixture");

    const tools = await createMcpHarnessTools(manager);
    const echo = toolNamed(tools, "echo");
    const increment = toolNamed(tools, "increment");

    expect(echo.name).toBe("mcp__fixture__echo");
    expect(echo.label).toBe("Echo");
    expect(echo.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(getAgentHarnessToolEffects(echo)).toEqual(["mcp.read"]);
    expect(getAgentHarnessToolEffects(increment)).toEqual(["mcp.read", "mcp.write"]);
    expect(echo.genericAi?.retrySemantics).toBe("safe-to-retry");
    expect(increment.genericAi?.retrySemantics).toBe("retry-may-duplicate");

    expect(textOf(await echo.execute("call-1", { text: "hi" }))).toBe("echo: hi");
    const counted = await increment.execute("call-2", { by: 2 });
    expect(textOf(counted)).toBe("count=2");
    expect(counted.details.structuredContent).toEqual({ count: 2 });
  });

  it("reports tool failures as structured tool errors", async () => {
    const manager = track(createMcpClientManager({ servers: [stdioServer()] }));
    const tools = await createMcpHarnessTools(manager);

    const error = await toolNamed(tools, "fail")
      .execute("call-1", {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenericAIToolError);
    expect((error as GenericAIToolError).message).toBe("fixture failure");
    expect((error as GenericAIToolError).envelope.metadata).toMatchObject({
      serverId: "fixture",
      toolName: "fail",
    });
  });

  it("passes env with placeholders to the server process", async () => {
    const manager = track(
      createMcpClientManager({
        servers: [stdioServer({ env: { FIXTURE_SECRET: placeholder("TEST_SECRET") } })],
        env: { TEST_SECRET: "s3cret" },
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    const result = JSON.parse(textOf(await toolNamed(tools, "whoami").execute("c", {})));
    expect(result.secret).toBe("s3cret");
  });

  it("fails clearly when a placeholder variable is missing", async () => {
    const manager = track(
      createMcpClientManager({
        servers: [stdioServer({ env: { FIXTURE_SECRET: placeholder("NOPE") }, required: true })],
        env: {},
      }),
    );
    await expect(manager.connect()).rejects.toMatchObject({
      name: "McpClientError",
      code: "MISSING_ENV",
    });
  });

  it("reconnects after the server process dies and keeps tools working", async () => {
    const events: McpClientEvent[] = [];
    const manager = track(
      createMcpClientManager({
        servers: [stdioServer()],
        reconnect: fastReconnect,
        onEvent: (event) => events.push(event),
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    const whoami = toolNamed(tools, "whoami");
    const before = JSON.parse(textOf(await whoami.execute("c1", {}))).instance;

    await toolNamed(tools, "crash").execute("c2", {});
    await waitFor(() => manager.status()[0]?.connectCount === 2);

    const after = JSON.parse(textOf(await whoami.execute("c3", {}))).instance;
    expect(after).not.toBe(before);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["connected", "disconnected", "reconnect_scheduled"]),
    );
  });

  it("refreshes tools when the server announces a tool list change", async () => {
    const manager = track(createMcpClientManager({ servers: [stdioServer()] }));
    const tools = await createMcpHarnessTools(manager);
    expect(tools.some((tool) => tool.mcp.toolName === "late")).toBe(false);

    await toolNamed(tools, "add_tool").execute("c1", {});
    await waitFor(async () => (await manager.listTools()).some(({ tool }) => tool.name === "late"));
    const refreshed = await createMcpHarnessTools(manager);
    expect(textOf(await toolNamed(refreshed, "late").execute("c2", {}))).toBe("late");
  });

  it("honours per-call timeouts", async () => {
    const manager = track(createMcpClientManager({ servers: [stdioServer({ timeoutMs: 100 })] }));
    const tools = await createMcpHarnessTools(manager);
    await expect(toolNamed(tools, "slow").execute("c1", { ms: 2_000 })).rejects.toThrow(
      /timed out/i,
    );
  });

  it("filters tools and applies read-only and effect overrides from config", async () => {
    const manager = track(
      createMcpClientManager({
        servers: [
          stdioServer({
            tools: { exclude: ["crash", "slow", "add_tool"] },
            trustAnnotations: false,
            readOnlyTools: ["whoami"],
            effects: ["network.egress"],
            toolEffects: { increment: ["custom.counter"] },
          }),
        ],
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    expect(tools.map((tool) => tool.mcp.toolName).sort()).toEqual([
      "echo",
      "fail",
      "increment",
      "whoami",
    ]);
    // Annotations are ignored, so echo becomes a write tool.
    expect(getAgentHarnessToolEffects(toolNamed(tools, "echo"))).toEqual([
      "mcp.read",
      "mcp.write",
      "network.egress",
    ]);
    expect(getAgentHarnessToolEffects(toolNamed(tools, "whoami"))).toEqual([
      "mcp.read",
      "network.egress",
    ]);
    expect(getAgentHarnessToolEffects(toolNamed(tools, "increment"))).toEqual(["custom.counter"]);
  });

  it("skips optional servers that fail and rejects required ones", async () => {
    const broken: McpServerDefinition = {
      id: "broken",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    };
    const optional = track(
      createMcpClientManager({ servers: [stdioServer(), broken], connectTimeoutMs: 5_000 }),
    );
    const tools = await createMcpHarnessTools(optional);
    expect(tools.every((tool) => tool.mcp.serverId === "fixture")).toBe(true);
    expect(optional.status().find((status) => status.id === "broken")?.state).toBe("failed");
    expect(optional.describeForPrompt()).toContain("broken (stdio, failed)");

    const required = track(
      createMcpClientManager({ servers: [{ ...broken, required: true }], connectTimeoutMs: 5_000 }),
    );
    await expect(createMcpHarnessTools(required)).rejects.toBeInstanceOf(McpClientError);
  });

  it("never connects disabled servers and refuses calls after close", async () => {
    const manager = createMcpClientManager({ servers: [stdioServer({ enabled: false })] });
    expect(await createMcpHarnessTools(manager)).toEqual([]);
    expect(manager.status()[0]?.state).toBe("disabled");
    await manager.close();
    await expect(manager.callTool("fixture", "echo", { text: "x" })).rejects.toMatchObject({
      code: "CLOSED",
    });
  });
});

describe("MCP client over Streamable HTTP", () => {
  it("connects with headers and calls tools", async () => {
    const fixture = track(await startHttp());
    const manager = track(
      createMcpClientManager({
        servers: [
          {
            id: "remote",
            transport: "http",
            url: fixture.url,
            headers: { Authorization: `Bearer ${placeholder("TOKEN")}` },
          },
        ],
        env: { TOKEN: "abc" },
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    const whoami = JSON.parse(textOf(await toolNamed(tools, "whoami").execute("c1", {})));
    expect(whoami.authorization).toBe("Bearer abc");
    expect(whoami.instance).toBe(fixture.instanceId);
  });

  it("reconnects to a restarted server and retries read-only calls", async () => {
    let fixture = await startHttp();
    cleanups.push(() => fixture.close());
    const manager = track(
      createMcpClientManager({
        servers: [{ id: "remote", transport: "http", url: fixture.url }],
        reconnect: fastReconnect,
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    const whoami = toolNamed(tools, "whoami");
    expect(JSON.parse(textOf(await whoami.execute("c1", {}))).instance).toBe(fixture.instanceId);

    const port = fixture.port;
    await fixture.close();
    fixture = await startHttp({ port, instanceId: "restarted" });

    // The old session is gone; the client reconnects and retries the read-only call once.
    expect(JSON.parse(textOf(await whoami.execute("c2", {}))).instance).toBe("restarted");
    expect(manager.status()[0]?.connectCount).toBe(2);
  });

  it("does not retry write calls after a dropped session", async () => {
    let fixture = await startHttp();
    cleanups.push(() => fixture.close());
    const manager = track(
      createMcpClientManager({
        servers: [{ id: "remote", transport: "http", url: fixture.url }],
        reconnect: fastReconnect,
      }),
    );
    const tools = await createMcpHarnessTools(manager);
    const increment = toolNamed(tools, "increment");
    await increment.execute("c1", {});

    const port = fixture.port;
    await fixture.close();
    fixture = await startHttp({ port });

    const error = await increment.execute("c2", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenericAIToolError);
    expect((error as GenericAIToolError).envelope).toMatchObject({
      kind: "upstream_unavailable",
      retryable: true,
    });
    // The client has reconnected in the background, so the next call works.
    await waitFor(() => manager.status()[0]?.state === "connected");
    expect(textOf(await increment.execute("c3", {}))).toMatch(/^count=/);
  });
});

describe("createMcpPlugin", () => {
  it("builds a manager and harness capability from plugin config", async () => {
    const plugin = track(
      createMcpPlugin({
        servers: [
          {
            id: "fixture",
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath, "stdio"],
            tools: { include: ["echo", "increment"] },
          },
        ],
        reconnect: { maxAttempts: 2 },
      }),
    );
    expect(plugin.capability.list().map((server) => server.id)).toEqual(["fixture"]);
    const tools = await plugin.capability.harnessTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__increment",
    ]);
  });
});

describe("mcpHarnessToolName", () => {
  it("sanitizes names and caps them at 64 characters", () => {
    const server: McpServerDefinition = { id: "my.server", transport: "http", url: "http://x" };
    expect(mcpHarnessToolName(server, "read file")).toBe("mcp__my_server__read_file");
    const long = mcpHarnessToolName(server, "x".repeat(100));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mcpHarnessToolName(server, `${"x".repeat(99)}y`));
    expect(mcpHarnessToolName({ ...server, toolPrefix: "gh" }, "search")).toBe("gh__search");
  });
});

export type { McpClientManager };
