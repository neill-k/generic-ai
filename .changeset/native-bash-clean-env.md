---
"@generic-ai/tools": minor
"@generic-ai/plugin-tools-terminal": patch
---

The native bash tool no longer passes the server's environment to commands. By default a command sees only allowlisted variables (`AGENT_COMMAND_ENV_KEYS`: paths, home and temp directories, shell, user, locale, terminal) and the session's `GENERIC_AI_*` variables, so provider keys and database URLs stay out of reach; `inheritProcessEnv: true` opts back in. Adds `getAgentCommandEnv`. `plugin-tools-terminal` passes its `inheritProcessEnv` option through to the bash tool.
