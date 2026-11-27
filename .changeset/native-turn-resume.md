---
"@generic-ai/session": minor
"@generic-ai/core": minor
"@generic-ai/sdk": minor
---

Resume a turn from its last completed step after a restart: `findResumePoint` and `prepareSessionResume` in `@generic-ai/session`, a `resume` option on native sessions, and a per-turn `session: { file, resume }` on harness runs, so a host keeps one session file per agent and re-runs an interrupted turn against it.
