# Schedules, heartbeats and background sessions

A native session can schedule its own future work. The agent schedules a prompt for later or on a
recurring schedule, or sets a heartbeat that keeps checking on long-running work. Jobs are saved in
the session. While the session runs, due jobs reach the agent. A job that comes due after the
session ends resumes the session from the durable queue. The parts follow Prime Agent's cron module
and scheduler (MIT); see `packages/autonomy/THIRD_PARTY_NOTICES.md`.

## Schedules

| Expression | Meaning |
| --- | --- |
| `in 10m`, `in 2h`, `in 1d` | Once, after the delay (minutes, hours or days). |
| `at 2026-12-01T09:00:00Z` | Once, at an ISO date-time in the future (UTC when no offset is given). |
| `every 30s`, `each 5m` | Recurring. The interval must be at least 10 seconds. |
| `@hourly`, `@daily`, `@weekly`, `@monthly` | Cron aliases. |
| `*/15 9-17 * * 1-5` | Five cron fields: minute, hour, day of month, month, weekday. UTC. Weekday 0 and 7 are Sunday. Fields take `*`, lists, ranges and `/step`. |

## Agent tools

`schedules: true` on `runCapabilityNativeAgentSession` (or on the agent harness, for every native
session) gives the agent:

- `cron_add` schedules a prompt (`prompt`, `schedule`, optional `label`). At most 20 active or paused
  jobs per session by default (`maxJobs`).
- `cron_list` lists jobs with their next and last runs.
- `cron_cancel` cancels a job by id.
- `heartbeat_set` starts the session's heartbeat (`instruction`, optional `every`, default
  `every 5m`, and `delivery_mode`). A session has at most one live heartbeat; a new one replaces it.
- `heartbeat_manage` pauses, resumes or stops the heartbeat.

`heartbeat: false` leaves out the two heartbeat tools. Hosts can drive the same `ScheduleBook` from
`@generic-ai/autonomy` directly, and `parseHeartbeatCommand` parses Prime's `/heartbeat` command
grammar (`/heartbeat --every 10m --follow-up check the build`, `pause`, `resume`, `stop`).

## Delivery while the session runs

A due job reaches the agent only while a turn is in progress; between turns it waits. The text
starts with a header such as `[heartbeat 1a2b3c4d, every 5m]` or `[scheduled job 9f8e7d6c, @daily]`
so the agent knows nobody typed it.

- A heartbeat in `steer` mode (the default) is delivered after the tool calls in flight finish.
- A heartbeat in `follow_up` mode, and every scheduled prompt, is delivered when the agent would
  otherwise stop.
- A heartbeat waits for its next slot instead of interrupting while the session compacts or runs a
  shell command, and a `follow_up` heartbeat also waits while a turn is in progress.

Each delivery emits a `native.schedule_fired` event with the job id, its source and how it was
delivered. The result's `schedules` lists the jobs still active or paused.

## Background sessions

`createScheduledSessionService` runs jobs that come due after their session ends. It takes the
SDK's durable queue, a `runSession` function that resumes the session and runs the prompt (usually
`runCapabilityNativeAgentSession` with the same `schedules` option), and optionally `openSession`
(defaults to `SessionManager.open`).

```ts
const service = createScheduledSessionService({
  queue,
  runSession: ({ sessionManager, prompt, signal }) =>
    runCapabilityNativeAgentSession({
      cwd,
      model,
      capabilities,
      prompt,
      sessionManager,
      signal,
      schedules: { service },
    }),
});
const worker = service.createWorker({ concurrency: 2 });
worker.start();

await runCapabilityNativeAgentSession({
  cwd,
  model,
  capabilities,
  prompt: "Check the deploy every hour and tell me when it is green.",
  sessionManager: SessionManager.create(cwd, sessionDir),
  schedules: { service },
});
```

- When a file-backed session with `schedules: { service }` ends, each active job's next run is
  queued as a `native.schedule.fire` job, available at the job's next run, with an idempotency key of
  session file, job id and slot, and a concurrency key per session so one session runs one fire at a
  time.
- A fire opens the session, checks that the job is still active and still due at that slot (a job
  that was cancelled, paused or already ran is dropped), claims it, runs the prompt, records the
  result, and queues the next slot of every active job, including jobs the agent added in that run.
- A fire for a session that is running in this process waits 30 seconds (`busyRetryMs`) and tries
  again. `isSessionBusy` covers sessions open in other processes.
- A failed run (a `failureMessage` or a throw) backs the job off: two minutes after the first
  failure, doubling, at most one hour. A one-shot job completes after its run either way.
- Missed slots are not replayed: after downtime a recurring job runs once and moves to its next
  slot.

The session's commands run as the agent does in any native session: the agent command environment
from `getAgentCommandEnv`, never the server's environment, and in the image as the separate agent
user (ADR 0064).
