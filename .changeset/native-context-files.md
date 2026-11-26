---
"@generic-ai/resources": minor
"@generic-ai/core": minor
---

Project context files. `loadProjectContextFiles` in `@generic-ai/resources` finds `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` from the agent directory and each ancestor of the working directory (with pi's worktree de-duplication and an optional `stopAt`), and native sessions show them in the system prompt when `contextFiles` (harness `native.contextFiles`) is set. Off by default.
