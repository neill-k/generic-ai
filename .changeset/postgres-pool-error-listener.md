---
"@generic-ai/plugin-storage-postgres": patch
---

A pool created by `openPostgresStorage` now listens for idle connection errors, so a database restart no longer crashes the process. The pool reconnects on the next query. Pass `onPoolError` to handle the errors yourself; the default writes a warning to stderr.
