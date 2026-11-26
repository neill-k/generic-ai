# 0065 — Background sessions on the durable queue

- Status: accepted
- Date: 2026-11-26
- Related: `0063-one-goal-mechanism-for-long-running-sessions.md`, `0064-agent-isolation-on-railway.md`,
  `docs/schedules.md`, `docs/planning/native-harness-parity.md` (slice 6b)

## Context

Prime Agent lets a session schedule prompts and a heartbeat. Its daemon keeps a
worker process per live session and a scheduler that wakes passive sessions from
a job store on disk. Generic AI already has a durable queue in the SDK (memory,
SQLite and Postgres drivers, leases, idempotent enqueue, per-key concurrency) and
runs on Railway, where processes restart and may run as more than one replica.
A second, file-based scheduler would duplicate the queue and would not survive a
multi-replica deploy.

## Decision

1. The schedule grammar, the per-session schedule book, the heartbeat rules, the
   schedule tools and the wake-timer runner live in `@generic-ai/autonomy`,
   adapted from Prime Agent. They have no storage of their own: the book hands
   every change to a `persist` callback.
2. Core saves the book in the session itself, as a `scheduled_jobs_state` custom
   entry, so a resumed or forked session carries its jobs.
3. While a session runs, core delivers due jobs into the running agent (steer or
   follow-up). After it ends, `createScheduledSessionService` queues each active
   job's next run on the SDK durable queue (`native.schedule.fire`, available at
   the next run, idempotency key session file plus job id plus slot, one
   concurrency key per session). A queue worker resumes the session, runs the
   prompt through a host-supplied `runSession`, records the result, and queues the
   next slot.
4. A fire re-reads the session and drops itself when the job moved on (cancelled,
   paused, or already run live), so live delivery and queued fires never run the
   same slot twice. A fire for a session open in this process waits and retries.
5. Scheduled runs are ordinary native sessions: agent commands get the clean
   agent environment and, in the image, the separate agent OS user (ADR 0064).

## Consequences

- Scheduled work survives restarts and runs on any replica that runs the worker.
- Missed slots after downtime are not replayed; a recurring job runs once and
  moves on, as in Prime Agent.
- Reattaching a client to a turn already running on another process is not
  covered; the queue resumes stored sessions between turns only.
- Hosts choose the model, capabilities and options of a scheduled run in
  `runSession`; nothing in the job lets the agent change them.
