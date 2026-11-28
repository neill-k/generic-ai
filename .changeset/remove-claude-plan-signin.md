---
"@generic-ai/auth": minor
"@generic-ai/ai": minor
---

Remove the Claude Pro/Max plan sign-in. Anthropic's terms don't allow third-party apps to use a Claude plan. `anthropicOAuth` is gone from `@generic-ai/auth`, and the Anthropic provider in `@generic-ai/ai` no longer shapes requests like Claude Code's: it refuses a Claude plan token (`sk-ant-oat...`) before sending and asks for an API key. `CLAUDE_CODE_IDENTITY`, `CLAUDE_CODE_VERSION`, `toClaudeCodeToolName`, `fromClaudeCodeToolName` and `AnthropicPayloadAuth` are removed, and `buildAnthropicPayload` and `consumeAnthropicEvents` lose their auth and tool-name arguments.
