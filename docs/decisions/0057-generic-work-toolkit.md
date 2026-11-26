# 0057. Generic Work Toolkit: Outward Effects, MCP Connectors and Web Search

## Context

Generic Corp agents do generic work, not only software work: research on the web, documents,
email, calendars and chat (decision D6, 26 Nov 2026). Most of those services already have MCP
servers, and `@generic-ai/plugin-mcp` is a real MCP client (PR #115). What was missing:

- a way to tell an approval policy that a tool reaches the outside world. `mcp.write` covers any
  change on any MCP server, so "add a label" and "send an email to a customer" looked the same;
- a way to classify a third-party server's tools without hand-writing an effect list for each one;
- a working `web_search`: the web tools plugin had a provider interface but no provider.

## Decision

1. The SDK gains three capability effects for outward actions, all in core's mutating set so only
   build roles hold them by default and the `benchmark-container` profile denies them:
   - `message.send`: reaches people outside the agent system (email, chat, posts, invites, RSVPs);
   - `external.write`: creates, changes or deletes records in an external system;
   - `payment.spend`: spends money or commits to a purchase.
   The approvals runtime (R11) gates tools by these effect names; tools need no other wiring.
2. MCP servers take an optional `connector` kind: `email`, `calendar`, `chat`, `documents`,
   `browser`, `payments` or `generic`. A connector's tools are classified by the verbs in their
   names: payment verbs first, then verbs that reach people, then the first read or write verb.
   Unrecognised tools count as `external.write` unless the server marks them read-only. Names win
   over a server's `readOnlyHint`, because a server that marks `send_email` read-only must still be
   gated. `toolEffects` (now accepting `*` patterns), `readOnly` and `readOnlyTools` override the
   classification.
3. Connectors name kinds, not vendors, except `browser`, which launches a pinned Playwright MCP
   (`@playwright/mcp@0.0.86 --headless --isolated`) when no launch is given. Credentials use the
   existing `${VAR}` placeholders until the secrets work (R12) replaces them.
4. `@generic-ai/plugin-tools-web` ships Brave, Tavily and SearXNG search providers and a
   config factory that resolves `${VAR}` keys.

## Consequences

- An owner can connect any email, calendar, chat or document MCP server with one `connector:` line
  and get safe defaults: reads flow to every role, outward actions reach only build roles and wait
  for approval once R11 lands.
- Name-based classification can misjudge an unusual tool name. It errs towards gating (unknown
  writes are `external.write`, "send" anywhere is `message.send`), and config overrides fix false
  positives such as `list_send_as_aliases`.
- Tests use fixture MCP servers that mimic mail, calendar, chat, documents and payments services
  with an in-memory outbox; no real account is touched.
- Document reading and writing (PDF, Word, spreadsheets) is a separate follow-up in this item.
