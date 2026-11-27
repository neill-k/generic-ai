# 0069 — The wall is between the company and the outside world

- Status: accepted
- Date: 2026-11-27
- Related: `0064-agent-isolation-on-railway.md`, design review decisions 32, 36–41
  (Claude Doc "Generic Corp design review: decisions")

## Context

ADR 0064 runs agent shell commands as a separate `agent` user so they cannot
read the server's secrets or files. It left open the network (agent commands
reached anything the server could), resource limits, and the pretence that
agents were walled from each other's homes while sharing one user.

The design review settled the threat this round must close: an agent reads a
web page, email or document that tells it to send the company's files
somewhere. Generic Corp has one owner (D4) and its agents are colleagues, so
the company is one trust zone (decision 40). The wall belongs between the
company and the outside world. The first real run is local Docker on the
owner's machine and Railway comes later, so the wall must work in both.

## Decision

**Network (decision 36).** Agent shell commands reach the network only through
an egress proxy the server runs on `127.0.0.1:3128`. It allows `CONNECT` (and
plain HTTP) to the hosts on an allowlist, ports 443 and 80, refuses bare IP
addresses and hosts that resolve to private addresses, and logs every refusal
to the owner's refused-actions list with the agent that tried it (each agent's
proxy URL carries its id and an HMAC token). The default allowlist is package
registries and GitHub. Commands get the proxy through `HTTPS_PROXY` and the
related variables, which npm, pip, git, curl and Node (with
`NODE_USE_ENV_PROXY=1`) honour. Reading the web stays with the web tools,
which run in the server and only fetch pages.

The proxy is the policy; the firewall makes it unavoidable. The entrypoint,
still root, adds an `iptables` owner-match rule: packets from the `agent` user
may go to the proxy port on loopback and nowhere else (no DNS, no Postgres, no
app port; IPv6 rejected outright), then drops `NET_ADMIN` and `NET_RAW` from
the bounding set before starting the server. At startup the server probes the
rule as the agent user and reports `agentNetwork` on `/ready`: `walled`,
`proxy-only` (no rule: no `NET_ADMIN`, or no separate agent user) or `open`
(`GENERIC_CORP_AGENT_NETWORK=off`). `required` refuses to start unless walled.

**Resource limits (decision 32).** The runAs wrapper applies hard `ulimit`
limits and `nice 10` to every agent command (see the
`@generic-ai/plugin-tools-terminal` README). There is no cgroup access inside
a Railway container, so there is no total per-agent cap.

## Consequences

- Local Docker gets the full wall (`compose.yaml` adds `NET_ADMIN`; the image
  smoke test checks direct connections, Postgres and the app port are
  unreachable and that the server dropped the capability).
- Railway documents no way to add capabilities, so it will likely run
  `proxy-only`: cooperative tools are limited, a command that deliberately
  ignores the proxy variables is not. A stronger Railway setup needs a
  separate sandbox service with its own egress rules.
- Allowlisted hosts accept writes to any account whose credentials a command
  holds (`git push`, `npm publish`). A page that hands an agent an outsider's
  token can still get files pushed there. Closing that needs a proxy that
  terminates TLS and allows only read requests, with its CA in the agent's
  trust store; deferred.
- MCP connectors and the browser connector run as the server, outside the
  shell wall. They are governed by the owner's permission categories instead.
- The web tools can still carry data out in a URL's query string. They send
  no bodies or custom headers; the permission categories and the
  refused-actions list are the control there.
