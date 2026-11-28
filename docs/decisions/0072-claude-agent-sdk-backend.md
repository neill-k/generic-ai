# 0072 — Claude turns on the owner's plan run in the Claude Agent SDK

- Status: accepted
- Date: 2026-11-28
- Related: design review decision 14 (powered by the owner's Claude
  subscription), decision 15 (plan usage limit), `0068-native-runtime-default.md`

## Context

The owner powers Generic Corp with his Claude plan. The native runtime used to
call the Messages API directly with a plan sign-in and shape requests like
Claude Code's. Anthropic bills that as extra usage and its terms rule it out:
developers "may not collect, store, or intermediate Claude.ai credentials", and
should not route requests through plan credentials. That path was removed (PR
214). Anthropic's terms do allow "an end user signing in to the unmodified
Claude Code binary with their own Claude subscription, including where a
platform hosts Claude Code", and its help center says the Claude Agent SDK
signed in with a plan draws from the plan's limits.

The owner chose this route on 2026-11-28 ("Run models via the Agent SDK"), and
said his real goal is the multi-agent layer plus goals and verification.

## Decision

- **The SDK owns the single-agent loop for Claude turns on the plan.** A new
  session backend (`apps/generic-corp/src/claude-agent-sdk.ts`, adapter kind
  `claude-agent-sdk`) runs each turn with `@anthropic-ai/claude-agent-sdk`.
  Context handling, retries and caching are Claude Code's. We do not rebuild our
  loop features (compaction, tool search, plan mode) inside it.
- **Everything above a turn stays ours**: delegation down the org chart,
  `ask_agent`, goals and validators agents can't edit, hand-in checks, the
  company drive, memory, the queue, usage per goal.
- **Only our tools.** Claude Code's built-in tools are off (`tools: []`) and no
  settings files load (`settingSources: []`). The run's tools are served to the
  SDK as one in-process MCP server with their own JSON schemas, so the
  permission wall, effect tags, run-as-agent-user isolation and the effect
  journal still apply to every call. Claude Code's auto memory, CLAUDE.md
  loading, bundled skills and non-essential traffic are switched off. The SDK's
  process gets a minimal environment, never the server's secrets.
- **The credential is the owner's, set by the owner.** He runs
  `claude setup-token` (Anthropic's sign-in) and sets `CLAUDE_CODE_OAUTH_TOKEN`
  on the server. The app reads the variable; it never runs a plan sign-in or
  stores the token, and refuses a plan token pasted as an API key. Generic Corp
  is single-owner (decision D4), so no one else's usage goes through it.
- **Routing.** With the token set, turns on Anthropic models run in the SDK;
  other models, and every turn while the token is absent or the owner chose to
  continue on an API key after the plan's limit, use the native runtime.
- **Plan limit.** The SDK's `rate_limit_event` (status `rejected`, `resetsAt`)
  becomes the failure the plan-reset hold already reads, so work pauses until
  the plan resets (or moves to the API key when the owner chose that).
- **Sessions.** One SDK session per agent per goal, kept in
  `<dataDir>/claude-agent-sdk` with its id next to the native session file, so
  a goal's later turns continue the conversation.
- **Usage.** Each model response is metered as it arrives with its tokens and
  what they would cost on the API, so tokens per finished goal stay comparable
  across power sources. The plan itself bills by limits, not dollars.

## Consequences

- The image carries the SDK's Claude Code binary (about 400 MB, linux-x64).
  The version is pinned and moves only on purpose.
- Plan mode and our compaction and tool search don't apply to SDK turns.
- Tests drive the real SDK against a fake Messages server on localhost; no test
  calls a model (the owner's standing rule).
- Advertised plan limits assume "ordinary, individual usage". An always-on
  company of agents is heavier than that; the plan-limit hold keeps it inside
  the limits rather than buying more.
