import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentHarnessToolEffects } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyConnectorTool,
  createMcpPlugin,
  isMcpToolOutward,
  MCP_CONNECTOR_PRESETS,
  type McpConnectorKind,
  type McpHarnessTool,
  mcpToolEffects,
  parseMcpPluginConfig,
  PLAYWRIGHT_MCP_PACKAGE,
  toolNameWords,
} from "../src/index.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/work-fixture-server.mjs",
);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function effectsOf(kind: McpConnectorKind, name: string, readOnlyHint?: boolean) {
  return classifyConnectorTool(kind, {
    name,
    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
  }).effects;
}

async function connectorTools(
  service: string,
  connector: McpConnectorKind,
  extra: Record<string, unknown> = {},
): Promise<Map<string, McpHarnessTool>> {
  const plugin = createMcpPlugin({
    servers: [
      {
        id: service,
        connector,
        transport: "stdio",
        command: process.execPath,
        args: [fixturePath, "stdio", service],
        ...extra,
      },
    ],
  });
  cleanups.push(() => plugin.close());
  const tools = await plugin.capability.harnessTools();
  return new Map(tools.map((tool) => [tool.mcp.toolName, tool]));
}

function effectsByTool(tools: Map<string, McpHarnessTool>): Record<string, readonly string[]> {
  return Object.fromEntries(
    [...tools].map(([name, tool]) => [name, getAgentHarnessToolEffects(tool)]),
  );
}

describe("connector tool classification", () => {
  it("splits tool names into words", () => {
    expect(toolNameWords("gmail_sendMessage")).toEqual(["gmail", "send", "message"]);
    expect(toolNameWords("browser-take.screenshot")).toEqual(["browser", "take", "screenshot"]);
  });

  it("tags sends as message.send even when the server claims they are read-only", () => {
    expect(effectsOf("email", "send_email", true)).toEqual([
      "mcp.read",
      "mcp.write",
      "message.send",
    ]);
    expect(effectsOf("email", "gmail_reply_to_thread")).toContain("message.send");
    expect(effectsOf("email", "forward_message")).toContain("message.send");
    expect(effectsOf("chat", "post_message")).toContain("message.send");
    expect(effectsOf("calendar", "respond_to_event")).toContain("message.send");
    expect(effectsOf("calendar", "accept_invite")).toContain("message.send");
    expect(effectsOf("documents", "share_file")).toContain("message.send");
  });

  it("keeps reads read-only, including names that mention messages", () => {
    for (const [kind, name] of [
      ["email", "get_message"],
      ["email", "list_sent_messages"],
      ["email", "search_threads"],
      ["calendar", "suggest_time"],
      ["chat", "get_channel_history"],
      ["documents", "read_file_content"],
      ["payments", "list_invoices"],
    ] as const) {
      expect(effectsOf(kind, name), `${kind}:${name}`).toEqual(["mcp.read"]);
    }
  });

  it("tags changes to external records as external.write", () => {
    expect(effectsOf("email", "create_draft")).toEqual(["mcp.read", "mcp.write", "external.write"]);
    expect(effectsOf("calendar", "delete_event")).toContain("external.write");
    expect(effectsOf("documents", "transfer_ownership")).toContain("external.write");
    expect(effectsOf("documents", "transfer_ownership")).not.toContain("payment.spend");
    // A read verb the server says writes is still treated as a write.
    expect(effectsOf("generic", "get_or_create_contact", false)).toContain("external.write");
    // No verb and no annotation: assume an outward write.
    expect(effectsOf("generic", "frobnicate")).toContain("external.write");
    expect(effectsOf("generic", "frobnicate", true)).toEqual(["mcp.read"]);
    expect(
      classifyConnectorTool(
        "generic",
        { name: "frobnicate", annotations: { readOnlyHint: true } },
        { trustAnnotations: false },
      ).effects,
    ).toContain("external.write");
  });

  it("tags money movement as payment.spend", () => {
    expect(effectsOf("payments", "create_refund")).toContain("payment.spend");
    expect(effectsOf("payments", "transfer_funds")).toContain("payment.spend");
    expect(effectsOf("generic", "purchase_domain")).toContain("payment.spend");
    expect(effectsOf("generic", "get_order")).toEqual(["mcp.read"]);
  });

  it("separates browser reading from browser interaction", () => {
    expect(effectsOf("browser", "browser_navigate")).toEqual(["mcp.read", "network.egress"]);
    expect(effectsOf("browser", "browser_snapshot")).toEqual(["mcp.read", "network.egress"]);
    expect(effectsOf("browser", "browser_click")).toEqual([
      "mcp.read",
      "mcp.write",
      "network.egress",
    ]);
    expect(effectsOf("browser", "browser_fill_form")).toContain("mcp.write");
    expect(effectsOf("browser", "browser_file_upload")).toContain("external.write");
  });
});

describe("connector config", () => {
  it("fills the browser connector's launch from its preset", () => {
    const config = parseMcpPluginConfig({ servers: [{ id: "web", connector: "browser" }] });
    expect(config.servers[0]).toMatchObject({
      id: "web",
      connector: "browser",
      transport: "stdio",
      command: "npx",
      args: ["-y", PLAYWRIGHT_MCP_PACKAGE, "--headless", "--isolated"],
      description: MCP_CONNECTOR_PRESETS.browser.description,
    });
  });

  it("keeps an explicit launch over the preset", () => {
    const config = parseMcpPluginConfig({
      servers: [
        { id: "web", connector: "browser", transport: "http", url: "http://127.0.0.1:9/mcp" },
      ],
    });
    expect(config.servers[0]).toMatchObject({ transport: "http", url: "http://127.0.0.1:9/mcp" });
    expect(config.servers[0]?.command).toBeUndefined();
  });

  it("asks for a launch when the connector has none", () => {
    expect(() => parseMcpPluginConfig({ servers: [{ id: "mail", connector: "email" }] })).toThrow(
      /connector "email" has no default launch/,
    );
    expect(() =>
      parseMcpPluginConfig({ servers: [{ id: "x", connector: "fax", transport: "stdio" }] }),
    ).toThrow(/connector must be one of/);
  });

  it("lets toolEffects patterns override connector classification", () => {
    const [server] = parseMcpPluginConfig({
      servers: [
        {
          id: "mail",
          connector: "email",
          transport: "stdio",
          command: "mail-mcp",
          toolEffects: { "list_send_as_*": ["mcp.read"], send_email: ["custom.outbox"] },
        },
      ],
    }).servers;
    if (server === undefined) {
      throw new Error("missing server");
    }
    expect(
      mcpToolEffects(server, { name: "list_send_as_aliases", inputSchema: { type: "object" } }),
    ).toEqual(["mcp.read"]);
    expect(mcpToolEffects(server, { name: "send_email", inputSchema: { type: "object" } })).toEqual(
      ["custom.outbox"],
    );
    expect(isMcpToolOutward(server, { name: "reply", inputSchema: { type: "object" } })).toBe(true);
  });

  it("lets readOnlyTools win over connector classification", () => {
    const [server] = parseMcpPluginConfig({
      servers: [
        {
          id: "mail",
          connector: "email",
          transport: "stdio",
          command: "mail-mcp",
          readOnlyTools: ["send_test_ping"],
        },
      ],
    }).servers;
    if (server === undefined) {
      throw new Error("missing server");
    }
    expect(
      mcpToolEffects(server, { name: "send_test_ping", inputSchema: { type: "object" } }),
    ).toEqual(["mcp.read"]);
  });
});

describe("connectors against fixture servers", () => {
  it("classifies a mail server's tools and still runs them", async () => {
    const tools = await connectorTools("mail", "email");
    expect(effectsByTool(tools)).toEqual({
      search_threads: ["mcp.read"],
      get_thread: ["mcp.read"],
      list_labels: ["mcp.read"],
      create_draft: ["mcp.read", "mcp.write", "external.write"],
      send_email: ["mcp.read", "mcp.write", "message.send"],
      reply_to_thread: ["mcp.read", "mcp.write", "message.send"],
      modify_labels: ["mcp.read", "mcp.write", "external.write"],
      get_outbox: ["mcp.read"],
    });

    const send = tools.get("send_email");
    expect(send?.description).toContain("outward action");
    expect(send?.genericAi?.reversibility).toBe("irreversible");
    expect(send?.genericAi?.retrySemantics).toBe("retry-may-duplicate");
    expect(send?.genericAi?.descriptor?.metadata).toMatchObject({
      connector: "email",
      outward: true,
    });

    await send?.execute("call-1", { to: "a@example.test", subject: "hi", body: "hello" });
    const outbox = await tools.get("get_outbox")?.execute("call-2", {});
    expect(outbox?.content[0]?.text).toContain("a@example.test");
  });

  it("classifies calendar, chat, documents and payments servers", async () => {
    const calendar = effectsByTool(await connectorTools("calendar", "calendar"));
    expect(calendar["list_events"]).toEqual(["mcp.read"]);
    expect(calendar["suggest_time"]).toEqual(["mcp.read"]);
    expect(calendar["create_event"]).toContain("external.write");
    expect(calendar["respond_to_event"]).toContain("message.send");

    const chat = effectsByTool(await connectorTools("chat", "chat"));
    expect(chat["list_channels"]).toEqual(["mcp.read"]);
    expect(chat["post_message"]).toContain("message.send");
    expect(chat["add_reaction"]).toContain("external.write");

    const docs = effectsByTool(await connectorTools("docs", "documents"));
    expect(docs["search_files"]).toEqual(["mcp.read"]);
    expect(docs["share_file"]).toContain("message.send");
    expect(docs["create_file"]).toContain("external.write");

    const payments = effectsByTool(await connectorTools("payments", "payments"));
    expect(payments["list_invoices"]).toEqual(["mcp.read"]);
    expect(payments["create_refund"]).toContain("payment.spend");
    expect(payments["transfer_funds"]).toContain("payment.spend");
  });

  it("adds server-wide effects on top of connector classification", async () => {
    const tools = await connectorTools("chat", "chat", { effects: ["network.egress"] });
    expect(getAgentHarnessToolEffects(tools.get("list_channels"))).toEqual([
      "mcp.read",
      "network.egress",
    ]);
  });

  it("names the connector in the prompt description", () => {
    const plugin = createMcpPlugin({
      servers: [{ id: "mail", connector: "email", transport: "stdio", command: "mail-mcp" }],
    });
    cleanups.push(() => plugin.close());
    expect(plugin.capability.describeForPrompt()).toContain("mail (stdio, email connector, idle)");
  });
});
