import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, type IncomingMessage, request } from "node:http";
import { BlockList, connect, createServer as createNetServer, isIP, type Socket } from "node:net";

import { wrapCommandForUser } from "@generic-ai/plugin-tools-terminal";

import type { AgentIsolation } from "./isolation.js";

/**
 * The wall between the company and the outside world for agent shell commands (design decision 36).
 *
 * Agent commands reach the network only through this egress proxy, which the server runs on
 * loopback. It lets through connections to the hosts on the owner's allowlist (package registries
 * and GitHub by default) and refuses everything else, logging each refusal for the owner. Other web
 * access goes through the web tools, which run in the server and only read pages.
 *
 * Commands get the proxy through the usual variables (`HTTPS_PROXY` and friends), which npm, pip,
 * git, curl and Node honour. A command could ignore them and connect directly, so in the image the
 * entrypoint also adds a firewall rule for the agent OS user: its packets may go to the proxy port
 * on loopback and nowhere else, DNS included (see docker-entrypoint.sh). That needs the
 * `NET_ADMIN` capability when the container starts; without it the wall is the proxy alone, and
 * `/ready` says so (`agentNetwork: "proxy-only"`).
 */
export const AGENT_NETWORK_ENV = Object.freeze({
  mode: "GENERIC_CORP_AGENT_NETWORK",
  port: "GENERIC_CORP_EGRESS_PORT",
});

export const DEFAULT_EGRESS_PORT = 3128;

/**
 * Hosts agent commands may reach when the owner has not set a list: package registries and GitHub.
 * `*.` matches any subdomain (not the bare domain).
 */
export const DEFAULT_SHELL_HOSTS: readonly string[] = Object.freeze([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
]);

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Checks and normalizes an allowlist entry: a host name, optionally starting with `*.`. */
export function normalizeHostPattern(pattern: string): string {
  const normalized = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_PATTERN.test(normalized) || normalized === "*" || normalized.length > 253) {
    throw new Error(`"${pattern}" is not a host name (use "example.com" or "*.example.com").`);
  }
  return normalized;
}

export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? normalized.endsWith(pattern.slice(1)) && normalized.length > pattern.length - 1
      : normalized === pattern,
  );
}

const PRIVATE_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 127],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(mapped);
  return family === 0 || PRIVATE_ADDRESSES.check(mapped, family === 6 ? "ipv6" : "ipv4");
}

/** Resolves a host and refuses private addresses, so the proxy never reaches the internal network. */
export type EgressResolver = (host: string) => Promise<string>;

const defaultResolver: EgressResolver = async (host) => {
  const records = await lookup(host, { all: true, verbatim: true });
  const address = records.find((record) => !isPrivateAddress(record.address))?.address;
  if (address === undefined || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error(`${host} resolves to a private address.`);
  }
  return address;
};

export interface EgressRefusal {
  readonly agentId?: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly reason: string;
}

export interface CreateEgressProxyOptions {
  /** The hosts allowed right now; read on every connection, so owner changes apply at once. */
  readonly allow: () => readonly string[];
  readonly onRefused?: (refusal: EgressRefusal) => void;
  readonly port?: number;
  readonly resolver?: EgressResolver;
  /** Ports a command may connect to on an allowed host. Defaults to 443 and 80. */
  readonly ports?: readonly number[];
}

export interface EgressProxy {
  /** Starts listening on 127.0.0.1. Resolves to the port in use. */
  start(): Promise<number>;
  /** Proxy variables for one agent's commands. The agent id is carried for the refusal log. */
  envFor(agentId: string): Record<string, string>;
  stop(): Promise<void>;
}

const REFUSAL_HINT =
  "Agent shell commands may only reach the hosts on the company's network allowlist. Read web pages with the web_fetch and web_search tools instead.";

/** Parses `host:port` from a CONNECT target. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(authority);
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { host: match[1] as string, port } : undefined;
}

export function createEgressProxy(options: CreateEgressProxyOptions): EgressProxy {
  const secret = randomBytes(32);
  const resolver = options.resolver ?? defaultResolver;
  const ports = new Set(options.ports ?? [443, 80]);
  const sockets = new Set<Socket>();
  let boundPort: number | undefined;

  const tokenFor = (agentId: string) =>
    createHmac("sha256", secret).update(agentId).digest("hex").slice(0, 32);

  /** The agent named in `Proxy-Authorization`, when its token is right. */
  const agentOf = (message: IncomingMessage): string | undefined => {
    const header = message.headers["proxy-authorization"];
    if (typeof header !== "string" || !header.startsWith("Basic ")) {
      return undefined;
    }
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return undefined;
    }
    const agentId = decodeURIComponent(decoded.slice(0, separator));
    const token = Buffer.from(decoded.slice(separator + 1));
    const expected = Buffer.from(tokenFor(agentId));
    return token.length === expected.length && timingSafeEqual(token, expected)
      ? agentId
      : undefined;
  };

  /** Decides one connection. Returns the address to connect to, or the refusal reason. */
  const decide = async (
    host: string,
    port: number,
  ): Promise<{ address: string } | { reason: string }> => {
    if (!ports.has(port)) {
      return { reason: `port ${port} is not allowed` };
    }
    if (isIP(host) !== 0) {
      return { reason: "connections to bare IP addresses are not allowed" };
    }
    if (!hostAllowed(host, options.allow())) {
      return { reason: `${host} is not on the network allowlist` };
    }
    try {
      return { address: await resolver(host) };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const refuse = (refusal: EgressRefusal) => {
    try {
      options.onRefused?.(refusal);
    } catch {
      // A failing log must not break the proxy.
    }
  };

  const server = createHttpServer(async (req, res) => {
    // Plain HTTP through the proxy: the request line carries an absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("This is an egress proxy; send absolute URLs.\n");
      return;
    }
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const agentId = agentOf(req);
    const decision = target.protocol === "http:" ? await decide(host, port) : undefined;
    if (decision === undefined || "reason" in decision) {
      const reason = decision?.reason ?? `${target.protocol} is not allowed`;
      refuse({
        ...(agentId === undefined ? {} : { agentId }),
        host,
        port,
        method: req.method ?? "GET",
        reason,
      });
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`Refused: ${reason}. ${REFUSAL_HINT}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = request(
      {
        host: decision.address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502).end("Upstream connection failed.\n");
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const authority = parseAuthority(req.url ?? "");
    const agentId = agentOf(req);
    const decision =
      authority === undefined
        ? { reason: "malformed CONNECT target" }
        : await decide(authority.host, authority.port);
    if ("reason" in decision) {
      refuse({
        ...(agentId === undefined ? {} : { agentId }),
        host: authority?.host ?? String(req.url),
        port: authority?.port ?? 0,
        method: "CONNECT",
        reason: decision.reason,
      });
      client.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nRefused: ${decision.reason}. ${REFUSAL_HINT}\n`,
      );
      return;
    }
    const upstream = connect({ host: decision.address, port: authority?.port ?? 443 });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (client.writable && upstream.connecting) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      } else {
        client.destroy();
      }
    });
    client.on("close", () => upstream.destroy());
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? DEFAULT_EGRESS_PORT, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          boundPort = typeof address === "object" && address !== null ? address.port : undefined;
          resolve(boundPort ?? 0);
        });
      });
    },
    envFor(agentId) {
      if (boundPort === undefined) {
        throw new Error("The egress proxy is not running.");
      }
      const url = `http://${encodeURIComponent(agentId)}:${tokenFor(agentId)}@127.0.0.1:${boundPort}`;
      return {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        ALL_PROXY: url,
        all_proxy: url,
        NO_PROXY: "",
        no_proxy: "",
        npm_config_proxy: url,
        npm_config_https_proxy: url,
        // Node's own fetch ignores the proxy variables unless told to use them.
        NODE_USE_ENV_PROXY: "1",
      };
    },
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      boundPort = undefined;
    },
  };
}

export type AgentNetworkPolicy = "auto" | "required" | "off";

/**
 * How agent commands reach the network:
 * - `walled`: through the proxy only; the firewall drops anything else the agent user sends.
 * - `proxy-only`: commands are pointed at the proxy, but a command that ignores the proxy
 *   variables can still connect directly (no firewall rule; no separate agent user, or no
 *   `NET_ADMIN` when the container started).
 * - `open`: no limit (`GENERIC_CORP_AGENT_NETWORK=off`).
 */
export type AgentNetworkMode = "walled" | "proxy-only" | "open";

export interface AgentNetwork {
  readonly mode: AgentNetworkMode;
  readonly reason?: string;
}

export class AgentNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNetworkError";
  }
}

export function readAgentNetworkPolicy(env: NodeJS.ProcessEnv): AgentNetworkPolicy {
  const raw = env[AGENT_NETWORK_ENV.mode];
  const policy = (raw ?? "auto").trim().toLowerCase() || "auto";
  if (policy === "auto" || policy === "required" || policy === "off") {
    return policy;
  }
  throw new AgentNetworkError(
    `${AGENT_NETWORK_ENV.mode} must be auto, required or off, not "${raw}".`,
  );
}

export function readEgressPort(env: NodeJS.ProcessEnv): number {
  const raw = env[AGENT_NETWORK_ENV.port]?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_EGRESS_PORT;
  }
  const port = Number(raw);
  // 0 picks a free port: tests only, since the image's firewall rule names the port.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new AgentNetworkError(`${AGENT_NETWORK_ENV.port} must be a port number.`);
  }
  return port;
}

/**
 * Checks, as the agent user, that the firewall holds: a connection to a loopback port other than
 * the proxy's must fail. Returns undefined when it does, or what went wrong.
 */
export type AgentNetworkProbe = (isolation: AgentIsolation) => Promise<string | undefined>;

export const probeAgentNetwork: AgentNetworkProbe = async (isolation) => {
  if (isolation.runAs === undefined) {
    return "agent commands run as the server's own user, so no firewall rule can single them out";
  }
  const runAs = isolation.runAs;
  const listener = createNetServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
  const address = listener.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const wrapped = wrapCommandForUser(
      `exec 3<>/dev/tcp/127.0.0.1/${port} && echo reached`,
      { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      { ...runAs, limits: false },
      "/",
    );
    const output = await new Promise<string>((resolve) => {
      const child = spawn("/bin/bash", ["-c", wrapped.command], {
        env: wrapped.env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.on("close", () => resolve(text));
      child.on("error", () => resolve(""));
    });
    return output.includes("reached")
      ? `the agent user "${runAs.user}" can open connections the proxy never sees (no firewall rule; the container needs NET_ADMIN at start)`
      : undefined;
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
};

/** Decides and checks how agent commands reach the network (see {@link AgentNetworkMode}). */
export async function resolveAgentNetwork(
  policy: AgentNetworkPolicy,
  isolation: AgentIsolation,
  probe: AgentNetworkProbe = probeAgentNetwork,
): Promise<AgentNetwork> {
  if (policy === "off") {
    return { mode: "open", reason: `${AGENT_NETWORK_ENV.mode} is off.` };
  }
  const failure = await probe(isolation);
  if (failure === undefined) {
    return { mode: "walled" };
  }
  if (policy === "required") {
    throw new AgentNetworkError(`${AGENT_NETWORK_ENV.mode} is required but ${failure}.`);
  }
  return { mode: "proxy-only", reason: failure };
}

export function describeAgentNetwork(network: AgentNetwork): string {
  switch (network.mode) {
    case "walled":
      return "Agent commands reach the network only through the egress allowlist.";
    case "proxy-only":
      return `WARNING: agent commands are pointed at the egress allowlist, but ${network.reason ?? "nothing stops a direct connection"}.`;
    default:
      return `WARNING: agent commands have open network access. ${network.reason ?? ""}`.trim();
  }
}
