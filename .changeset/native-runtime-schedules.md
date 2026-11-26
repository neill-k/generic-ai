---
"@generic-ai/autonomy": minor
"@generic-ai/core": minor
---

Add schedules and heartbeats to native sessions. `@generic-ai/autonomy` gains schedule parsing (`in 10m`, `at <ISO date>`, `every 5m`, cron in UTC), a per-session schedule book with heartbeats and failure backoff, the `cron_add`, `cron_list`, `cron_cancel`, `heartbeat_set` and `heartbeat_manage` tools, and a wake-timer runner. Core turns them on with the `schedules` option, delivers due jobs into the running agent, and adds `createScheduledSessionService`, which resumes stored sessions for due jobs from the SDK durable queue.
