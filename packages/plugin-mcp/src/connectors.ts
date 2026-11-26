import type { AgentHarnessCapabilityEffect } from "@generic-ai/sdk";

import type { McpToolInfo } from "./client.js";

/**
 * Connector kinds for generic (non-code) work. A server tagged with a kind gets its tools classified
 * by what they do to the outside world, so approval policies can gate outward actions:
 *
 * - `message.send`: reaches people outside the agent system (email, chat, posts, invites, RSVPs).
 * - `external.write`: creates, changes or deletes records in an external system.
 * - `payment.spend`: spends money or commits to a purchase.
 *
 * Classification reads the tool name, not the server's annotations, because a server that marks a
 * send tool `readOnlyHint: true` must still be gated. Config `toolEffects` always wins.
 */
export const MCP_CONNECTOR_KINDS = [
  "browser",
  "email",
  "calendar",
  "chat",
  "documents",
  "payments",
  "generic",
] as const;

export type McpConnectorKind = (typeof MCP_CONNECTOR_KINDS)[number];

export const MESSAGE_SEND_EFFECT: AgentHarnessCapabilityEffect = "message.send";
export const EXTERNAL_WRITE_EFFECT: AgentHarnessCapabilityEffect = "external.write";
export const PAYMENT_SPEND_EFFECT: AgentHarnessCapabilityEffect = "payment.spend";

/** Effects that mark an action leaving the agent system. Approval policies gate these. */
export const OUTWARD_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  MESSAGE_SEND_EFFECT,
  EXTERNAL_WRITE_EFFECT,
  PAYMENT_SPEND_EFFECT,
]);

/** Launch defaults a connector kind can supply when the server entry leaves them out. */
export interface McpConnectorLaunchDefaults {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
}

export interface McpConnectorPreset {
  readonly kind: McpConnectorKind;
  readonly description: string;
  readonly launch?: McpConnectorLaunchDefaults;
}

/** Pinned so a run never picks up an unreviewed browser server release. */
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.86";

export const MCP_CONNECTOR_PRESETS: Readonly<Record<McpConnectorKind, McpConnectorPreset>> =
  Object.freeze({
    browser: {
      kind: "browser",
      description:
        "Web browser: open pages, read them as accessibility snapshots, click, type and fill forms.",
      launch: {
        transport: "stdio",
        command: "npx",
        args: ["-y", PLAYWRIGHT_MCP_PACKAGE, "--headless", "--isolated"],
      },
    },
    email: {
      kind: "email",
      description: "Email: search and read mail, draft, label and send messages.",
    },
    calendar: {
      kind: "calendar",
      description: "Calendar: read schedules, find free time, create and change events.",
    },
    chat: {
      kind: "chat",
      description: "Team chat: read channels and threads, post messages and reactions.",
    },
    documents: {
      kind: "documents",
      description: "Documents and files: search, read, create, edit and share documents.",
    },
    payments: {
      kind: "payments",
      description: "Payments: read balances and invoices, charge, refund and pay.",
    },
    generic: {
      kind: "generic",
      description: "External service: tools that send, change or pay are gated as outward actions.",
    },
  });

export function isMcpConnectorKind(value: unknown): value is McpConnectorKind {
  return typeof value === "string" && (MCP_CONNECTOR_KINDS as readonly string[]).includes(value);
}

const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "find",
  "query",
  "view",
  "show",
  "describe",
  "lookup",
  "download",
  "export",
  "count",
  "check",
  "preview",
  "suggest",
  "browse",
  "inspect",
  "summarize",
  "watch",
  "retrieve",
]);

const WRITE_VERBS = new Set([
  "create",
  "add",
  "update",
  "edit",
  "modify",
  "set",
  "delete",
  "remove",
  "trash",
  "untrash",
  "archive",
  "unarchive",
  "move",
  "rename",
  "upload",
  "write",
  "insert",
  "append",
  "patch",
  "put",
  "mark",
  "label",
  "unlabel",
  "star",
  "unstar",
  "cancel",
  "schedule",
  "reschedule",
  "copy",
  "duplicate",
  "restore",
  "clear",
  "apply",
  "assign",
  "close",
  "reopen",
  "replace",
  "save",
  "draft",
  "pin",
  "unpin",
  "mute",
  "join",
  "leave",
  "import",
  "merge",
  "approve",
  "reject",
  "submit",
  "batch",
  "bulk",
  "manage",
  "do",
  "execute",
  "run",
  "trigger",
]);

/** Verbs that reach people. Anywhere in a tool name they make it `message.send`. */
const SEND_VERBS = new Set([
  "send",
  "reply",
  "forward",
  "respond",
  "rsvp",
  "accept",
  "decline",
  "invite",
  "post",
  "publish",
  "share",
  "broadcast",
  "notify",
  "comment",
  "react",
  "mention",
  "dm",
  "message",
  "email",
  "tweet",
  "unshare",
]);

/** Verbs that move money on any connector. Anywhere in a tool name they make it `payment.spend`. */
const PAYMENT_VERBS = new Set(["pay", "purchase", "buy", "checkout", "donate", "payout"]);

/** Extra money verbs on `payments` connectors, where they cannot mean anything else. */
const PAYMENTS_KIND_VERBS = new Set([
  "charge",
  "refund",
  "transfer",
  "subscribe",
  "withdraw",
  "capture",
  "send",
]);

/** Browser tools that act on a page rather than only reading it. */
const BROWSER_INTERACT_WORDS = new Set([
  "click",
  "type",
  "fill",
  "press",
  "select",
  "drag",
  "evaluate",
  "dialog",
  "run",
  "code",
  "mouse",
  "keyboard",
  "form",
  "check",
  "uncheck",
  "submit",
  "drop",
]);

/** Split a tool name into lower-case words: `gmail_sendMessage` -> [gmail, send, message]. */
export function toolNameWords(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

const MESSAGE_NOUN_VERBS = new Set(["message", "email", "dm"]);

function hasSendVerb(words: readonly string[], kind: McpConnectorKind): boolean {
  return words.some((word, index) => {
    if (!SEND_VERBS.has(word)) {
      return false;
    }
    // "message" and "email" are usually nouns ("get_message", "list_emails"). They only count as a
    // verb when they lead the name ("message_user", "email_customer").
    if (MESSAGE_NOUN_VERBS.has(word)) {
      return index === 0;
    }
    // Accepting or declining reaches someone only on calendars and in chat-like flows.
    if ((word === "accept" || word === "decline") && kind !== "calendar") {
      return false;
    }
    return true;
  });
}

function firstVerb(words: readonly string[]): "read" | "write" | undefined {
  for (const word of words) {
    if (READ_VERBS.has(word)) {
      return "read";
    }
    if (WRITE_VERBS.has(word)) {
      return "write";
    }
  }
  return undefined;
}

export interface ConnectorToolClassification {
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  readonly readOnly: boolean;
  /** Which rule decided, for policy decision records and debugging. */
  readonly reason: string;
}

const READ_ONLY: readonly AgentHarnessCapabilityEffect[] = Object.freeze(["mcp.read"]);

function classification(
  effects: readonly AgentHarnessCapabilityEffect[],
  reason: string,
): ConnectorToolClassification {
  return Object.freeze({
    effects: Object.freeze([...new Set(effects)]),
    readOnly: !effects.some((effect) => effect !== "mcp.read" && effect !== "network.egress"),
    reason,
  });
}

function classifyBrowserTool(words: readonly string[]): ConnectorToolClassification {
  if (words.includes("upload")) {
    return classification(
      ["mcp.read", "mcp.write", "network.egress", EXTERNAL_WRITE_EFFECT],
      "browser upload sends local files to a site",
    );
  }
  if (words.some((word) => BROWSER_INTERACT_WORDS.has(word))) {
    return classification(
      ["mcp.read", "mcp.write", "network.egress"],
      "browser interaction can change page state",
    );
  }
  return classification(["mcp.read", "network.egress"], "browser navigation and reading");
}

/**
 * Classify one tool of a connector server. Order: payment verbs, send verbs, then the first read or
 * write verb in the name. A tool with no recognisable verb falls back to its `readOnlyHint`
 * annotation (when trusted) and otherwise counts as `external.write`.
 */
export function classifyConnectorTool(
  kind: McpConnectorKind,
  tool: Pick<McpToolInfo, "name" | "annotations">,
  options: { readonly trustAnnotations?: boolean } = {},
): ConnectorToolClassification {
  const words = toolNameWords(tool.name);
  if (kind === "browser") {
    return classifyBrowserTool(words);
  }
  if (
    words.some(
      (word) => PAYMENT_VERBS.has(word) || (kind === "payments" && PAYMENTS_KIND_VERBS.has(word)),
    )
  ) {
    return classification(
      ["mcp.read", "mcp.write", PAYMENT_SPEND_EFFECT, EXTERNAL_WRITE_EFFECT],
      "name has a payment verb",
    );
  }
  if (hasSendVerb(words, kind)) {
    return classification(
      ["mcp.read", "mcp.write", MESSAGE_SEND_EFFECT],
      "name has a verb that reaches people",
    );
  }
  const verb = firstVerb(words);
  const annotatedWrite = tool.annotations?.readOnlyHint === false;
  if (verb === "read" && !annotatedWrite) {
    return classification(READ_ONLY, "name starts with a read verb");
  }
  if (verb === "write" || annotatedWrite) {
    return classification(
      ["mcp.read", "mcp.write", EXTERNAL_WRITE_EFFECT],
      verb === "write" ? "name has a write verb" : "server marks the tool as writing",
    );
  }
  if (options.trustAnnotations !== false && tool.annotations?.readOnlyHint === true) {
    return classification(READ_ONLY, "server marks the tool read-only");
  }
  return classification(
    ["mcp.read", "mcp.write", EXTERNAL_WRITE_EFFECT],
    "unrecognised tool on an external connector",
  );
}
