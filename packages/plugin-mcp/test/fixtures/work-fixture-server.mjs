// Fake email, calendar, chat, documents and payments MCP server for connector tests. Nothing here
// reaches a real account: every "sent" item lands in an in-memory outbox that `get_outbox` returns.
// Run as `node work-fixture-server.mjs stdio <service>`, where <service> is mail, calendar, chat,
// docs or payments. Tool names follow common real-world servers so classification is exercised.
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const outbox = [];
const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

function tool(server, name, description, inputSchema, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema, annotations }, handler);
}

const SERVICES = {
  mail(server) {
    const messages = [
      { id: "m1", from: "ceo@example.test", subject: "Q3 plan", body: "Draft attached." },
    ];
    tool(server, "search_threads", "Search mail threads.", { query: z.string() }, async () =>
      text(messages),
    );
    tool(server, "get_thread", "Read one thread.", { id: z.string() }, async ({ id }) =>
      text(messages.find((message) => message.id === id) ?? null),
    );
    tool(server, "list_labels", "List labels.", {}, async () => text(["inbox", "sent"]));
    tool(
      server,
      "create_draft",
      "Create a draft.",
      { to: z.string(), subject: z.string(), body: z.string() },
      async (draft) => text({ draftId: "d1", ...draft }),
    );
    tool(
      server,
      "send_email",
      "Send an email.",
      { to: z.string(), subject: z.string(), body: z.string() },
      async (mail) => {
        outbox.push({ kind: "email", ...mail });
        return text("sent");
      },
      // A careless server annotation: classification must still gate this tool.
      { readOnlyHint: true },
    );
    tool(
      server,
      "reply_to_thread",
      "Reply in a thread.",
      { id: z.string(), body: z.string() },
      async (reply) => {
        outbox.push({ kind: "reply", ...reply });
        return text("replied");
      },
    );
    tool(server, "modify_labels", "Add or remove labels.", { id: z.string() }, async () =>
      text("ok"),
    );
    tool(server, "get_outbox", "Fixture only: what was sent.", {}, async () => text(outbox), {
      readOnlyHint: true,
    });
  },
  calendar(server) {
    tool(server, "list_events", "List events.", {}, async () =>
      text([{ id: "e1", title: "Standup" }]),
    );
    tool(server, "suggest_time", "Find free time.", { minutes: z.number() }, async () =>
      text("2026-12-01T10:00:00Z"),
    );
    tool(server, "create_event", "Create an event.", { title: z.string() }, async ({ title }) => {
      outbox.push({ kind: "event", title });
      return text({ id: "e2", title });
    });
    tool(server, "delete_event", "Delete an event.", { id: z.string() }, async () =>
      text("deleted"),
    );
    tool(
      server,
      "respond_to_event",
      "RSVP to an event.",
      { id: z.string(), response: z.string() },
      async () => text("responded"),
    );
  },
  chat(server) {
    tool(server, "list_channels", "List channels.", {}, async () => text(["general"]));
    tool(server, "get_channel_history", "Read a channel.", { channel: z.string() }, async () =>
      text([{ user: "u1", text: "hello" }]),
    );
    tool(
      server,
      "post_message",
      "Post to a channel.",
      { channel: z.string(), text: z.string() },
      async (post) => {
        outbox.push({ kind: "chat", ...post });
        return text("posted");
      },
    );
    tool(server, "add_reaction", "React to a message.", { ts: z.string() }, async () => text("ok"));
  },
  docs(server) {
    tool(server, "search_files", "Search files.", { query: z.string() }, async () => text([]));
    tool(server, "read_file_content", "Read a file.", { id: z.string() }, async () =>
      text("# Plan"),
    );
    tool(server, "create_file", "Create a file.", { name: z.string() }, async () => text("f1"));
    tool(
      server,
      "share_file",
      "Share a file with someone.",
      { id: z.string(), email: z.string() },
      async () => text("shared"),
    );
    tool(server, "transfer_ownership", "Transfer file ownership.", { id: z.string() }, async () =>
      text("ok"),
    );
  },
  payments(server) {
    tool(server, "list_invoices", "List invoices.", {}, async () => text([]));
    tool(server, "create_refund", "Refund a charge.", { charge: z.string() }, async () =>
      text("ok"),
    );
    tool(server, "transfer_funds", "Move money.", { amount: z.number() }, async () => text("ok"));
  },
};

export function createWorkFixtureServer(service) {
  const register = SERVICES[service];
  if (register === undefined) {
    throw new Error(`Unknown fixture service "${service}".`);
  }
  const server = new McpServer({ name: `work-fixture-${service}`, version: "1.0.0" });
  register(server);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "stdio") {
  await createWorkFixtureServer(process.argv[3] ?? "mail").connect(new StdioServerTransport());
}
