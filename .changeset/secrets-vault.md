---
"@generic-ai/plugin-secrets": minor
"@generic-ai/sdk": minor
"@generic-ai/core": minor
"@generic-ai/plugin-mcp": minor
"@generic-ai/plugin-tools-terminal-sandbox": patch
---

Add a secrets vault: SDK `SecretsBinding` and `{{secret:NAME}}` placeholder contracts, `role.secrets` and `harness.secrets` grants, harness wrapping of every role's tools so placeholders resolve at call time and secret values are redacted from tool output and canonical events with `secret.read` audit decisions, MCP `${VAR}` resolution from the vault, Docker sandbox env passed by name instead of on the command line, and the new `@generic-ai/plugin-secrets` package with env, file and AES-256-GCM encrypted-store sources.
