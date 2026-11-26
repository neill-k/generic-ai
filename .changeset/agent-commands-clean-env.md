---
"@generic-ai/plugin-tools-terminal": patch
"@generic-ai/tools": patch
---

Commands an agent runs no longer see the host's environment. The agent-facing bash tool from `createTerminalToolPlugin` passed the whole `process.env` (provider keys, `DATABASE_URL`, secrets) to every command, because the bash tool hands its spawn hook the full environment and the plugin layered it over its allowlist. The hook now keeps only allowlisted keys unless `inheritProcessEnv` is set. The grep and find tools also give `rg` and `fd` an allowlisted environment (`getSearchHelperEnv`).
