---
"@generic-ai/plugin-tools-files": patch
"@generic-ai/core": patch
"@generic-ai/sdk": patch
---

Agent-facing file tools stay inside the agent's workspace. `createWorkspaceFileTools` handed agents the read, write, edit, ls, find and grep tools from `@generic-ai/tools`, which accept any absolute path and run inside the server process, so an agent could read `/proc/self/environ` (the server's provider keys and database URL) or write into other agents' homes. Every `path` is now resolved, symlinks included, and refused with `WorkspaceBoundaryError` when it lands outside the root.

Command lifecycle hooks no longer inherit the server's environment. They start from the allowlisted environment agent commands get (`getAgentCommandEnv`), plus the hook's `env`; a hook that needs a server variable names it in the new `handler.passEnv`.
