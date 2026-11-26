// MCP fixture server for plugin-mcp tests. Run as `node fixture-server.mjs stdio` for the stdio
// transport, or import `startHttpFixture` for a Streamable HTTP server on a local port.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const state = { counter: 0 };

export function createFixtureServer(options = {}) {
  const server = new McpServer({ name: "generic-ai-fixture", version: "1.0.0" });
  const instance = options.instanceId ?? `pid-${process.pid}`;

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo the given text.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );

  server.registerTool(
    "increment",
    {
      description: "Increment a counter on the server.",
      inputSchema: { by: z.number().int().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ by }) => {
      state.counter += by ?? 1;
      return {
        content: [{ type: "text", text: `count=${state.counter}` }],
        structuredContent: { count: state.counter },
      };
    },
  );

  server.registerTool(
    "fail",
    { description: "Always fails.", annotations: { readOnlyHint: true } },
    async () => ({ isError: true, content: [{ type: "text", text: "fixture failure" }] }),
  );

  server.registerTool(
    "whoami",
    {
      description: "Report the server instance, an env var and the request auth header.",
      annotations: { readOnlyHint: true },
    },
    async (extra) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            instance,
            secret: process.env.FIXTURE_SECRET ?? null,
            authorization: extra.requestInfo?.headers?.authorization ?? null,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "crash",
    { description: "Exit the server process (stdio only).", annotations: { readOnlyHint: true } },
    async () => {
      setTimeout(() => process.exit(1), 5);
      return { content: [{ type: "text", text: "crashing" }] };
    },
  );

  server.registerTool(
    "add_tool",
    { description: "Register a new tool named late.", annotations: { readOnlyHint: false } },
    async () => {
      server.registerTool(
        "late",
        { description: "Added at runtime.", annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "late" }] }),
      );
      return { content: [{ type: "text", text: "added" }] };
    },
  );

  server.registerTool(
    "slow",
    { description: "Wait before answering.", inputSchema: { ms: z.number().int() } },
    async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { content: [{ type: "text", text: "slow done" }] };
    },
  );

  return server;
}

/** Start a stateful Streamable HTTP fixture. Resolves to its url and a close function. */
export async function startHttpFixture(options = {}) {
  const sessions = new Map();
  const instanceId = options.instanceId ?? randomUUID();
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? JSON.parse(raw) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (transport === undefined) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }),
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) {
          sessions.delete(transport.sessionId);
        }
      };
      await createFixtureServer({ instanceId }).connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });

  await new Promise((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = http.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    port: address.port,
    instanceId,
    async close() {
      for (const transport of sessions.values()) {
        await transport.close().catch(() => undefined);
      }
      sessions.clear();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(() => resolve()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "stdio") {
  await createFixtureServer().connect(new StdioServerTransport());
}
