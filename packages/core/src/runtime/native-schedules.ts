import type { Agent, AgentMessage, AgentTool } from "@generic-ai/agent";
import {
  type ClaimedJob,
  createScheduleTools,
  isScheduleBookState,
  SCHEDULES_CUSTOM_TYPE,
  ScheduleBook,
  type ScheduleBookState,
  type ScheduledJob,
  ScheduleRunner,
  type SessionActivity,
  scheduledPromptText,
  shouldDeferHeartbeat,
} from "@generic-ai/autonomy";
import type {
  DurableQueueContract,
  DurableQueueLease,
  QueueWorker,
  QueueWorkerOptions,
} from "@generic-ai/sdk";
import { createQueueWorker } from "@generic-ai/sdk";
import { SessionManager } from "@generic-ai/session";

/**
 * Scheduled prompts and a heartbeat for a native session (see `@generic-ai/autonomy` and
 * `docs/schedules.md`). The agent gets `cron_add`, `cron_list`, `cron_cancel`, `heartbeat_set` and
 * `heartbeat_manage`; the jobs are saved in the session. While the session runs, due jobs reach the
 * agent: a heartbeat steers the turn in progress, and a scheduled prompt arrives as a follow-up. A
 * job that comes due after the session ends runs through a {@link ScheduledSessionService}, which
 * resumes the session from the durable queue.
 */
export interface NativeSessionSchedules {
  /** Give the agent the heartbeat tools. Defaults to true. */
  readonly heartbeat?: boolean;
  /** At most this many active or paused jobs. Defaults to 20. */
  readonly maxJobs?: number;
  /**
   * Runs jobs that come due after this session ends. The session must be file-backed. When it ends,
   * its jobs are queued, and while it runs the service holds back fires for it.
   */
  readonly service?: ScheduledSessionService;
}

export interface SessionSchedules {
  readonly book: ScheduleBook;
  readonly tools: readonly AgentTool[];
  /** Delivers due jobs to the running agent until the returned function is called. */
  bindAgent(agent: Agent, activity: () => SessionActivity): () => Promise<void>;
}

function latestBookState(sessionManager: SessionManager): ScheduleBookState | undefined {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === SCHEDULES_CUSTOM_TYPE &&
      isScheduleBookState(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

/** The schedule book saved in a session, persisting every change back to it. */
export function loadSessionScheduleBook(
  sessionManager: SessionManager,
  options: { readonly now?: () => number } = {},
): ScheduleBook {
  return new ScheduleBook({
    state: latestBookState(sessionManager),
    persist: (state) => {
      sessionManager.appendCustomEntry(SCHEDULES_CUSTOM_TYPE, state);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

export function createSessionSchedules(input: {
  readonly sessionManager: SessionManager;
  readonly schedules: NativeSessionSchedules | boolean | undefined;
  readonly onFire?: (job: ScheduledJob, delivery: "steer" | "follow_up" | "deferred") => void;
}): SessionSchedules | undefined {
  const options =
    input.schedules === true ? {} : input.schedules === false ? undefined : input.schedules;
  if (options === undefined) {
    return undefined;
  }
  const book = loadSessionScheduleBook(input.sessionManager);
  const tools = createScheduleTools(book, {
    heartbeat: options.heartbeat,
    maxJobs: options.maxJobs,
  }) as AgentTool[];
  return {
    book,
    tools,
    bindAgent: (agent, activity) => {
      const runner = new ScheduleRunner({
        book,
        // Live delivery needs a turn in progress; between turns the jobs wait, and after the
        // session they go to the service.
        ready: () => agent.state.isStreaming,
        run: ({ job }: ClaimedJob) => {
          if (shouldDeferHeartbeat(job, { ...activity(), isStreaming: true })) {
            input.onFire?.(job, "deferred");
            return "skipped";
          }
          const message = userMessage(scheduledPromptText(job));
          const steer = job.source === "heartbeat" && job.deliveryMode !== "follow_up";
          if (steer) {
            agent.steer(message);
          } else {
            agent.followUp(message);
          }
          input.onFire?.(job, steer ? "steer" : "follow_up");
          return "ran";
        },
      });
      runner.start();
      return () => runner.stop();
    },
  };
}

/** A queued run of one scheduled job in a stored session. */
export interface ScheduledSessionFire {
  readonly sessionFile: string;
  readonly jobId: string;
  /** The slot the job was due at; a fire whose job has moved on is dropped. */
  readonly scheduledFor: string;
}

export type ScheduledSessionFireOutcome = "ran" | "failed" | "skipped" | "stale" | "busy";

export interface ScheduledSessionFireResult {
  readonly outcome: ScheduledSessionFireOutcome;
  readonly jobId: string;
  readonly error?: string;
}

export interface ScheduledSessionRunInput {
  readonly sessionFile: string;
  readonly sessionManager: SessionManager;
  /** The text to send, with a `[scheduled job ...]` or `[heartbeat ...]` header. */
  readonly prompt: string;
  readonly job: ScheduledJob;
  readonly signal: AbortSignal;
}

export interface ScheduledSessionServiceOptions {
  readonly queue: DurableQueueContract<ScheduledSessionFire, ScheduledSessionFireResult>;
  /**
   * Resumes the session and runs the prompt, usually with `runCapabilityNativeAgentSession` and the
   * same `schedules` option (so the agent can manage its jobs). A returned `failureMessage` or a
   * throw counts as a failed run, which backs the job off.
   */
  readonly runSession: (
    input: ScheduledSessionRunInput,
  ) => Promise<{ readonly failureMessage?: string } | undefined>;
  /** Opens a stored session. Defaults to `SessionManager.open`. */
  readonly openSession?: (sessionFile: string) => SessionManager;
  /**
   * True while the session is open somewhere this service cannot see (another process). Sessions
   * run with this service's `schedules` option in this process are tracked without it.
   */
  readonly isSessionBusy?: (sessionFile: string) => boolean | Promise<boolean>;
  /** How long a fire for a busy session waits. Defaults to 30 seconds. */
  readonly busyRetryMs?: number;
  readonly now?: () => number;
}

export const SCHEDULED_SESSION_JOB = "native.schedule.fire";

/**
 * Background sessions: runs a stored session's scheduled jobs from a durable queue, so they survive
 * restarts and run on any worker. Each fire resumes the session, runs the prompt, records the
 * result, and queues the job's next slot. Fires for one session run one at a time.
 */
export interface ScheduledSessionService {
  /** Queues the next run of every active job in the session. Returns how many fires it queued. */
  sync(sessionFile: string, sessionManager?: SessionManager): Promise<number>;
  /** Runs one leased fire; the queue worker's handler. */
  handle(
    lease: Pick<DurableQueueLease<ScheduledSessionFire>, "payload">,
    signal?: AbortSignal,
  ): Promise<ScheduledSessionFireResult>;
  /** Marks a session as running here, so its fires wait. Returns the release. */
  markOpen(sessionFile: string): () => void;
  createWorker(
    options?: Omit<QueueWorkerOptions<ScheduledSessionFire, ScheduledSessionFireResult>, "names">,
  ): QueueWorker;
}

export function createScheduledSessionService(
  options: ScheduledSessionServiceOptions,
): ScheduledSessionService {
  const now = options.now ?? Date.now;
  const open = options.openSession ?? ((file: string) => SessionManager.open(file));
  const openHere = new Map<string, number>();
  const busyRetryMs = options.busyRetryMs ?? 30_000;

  const enqueue = async (fire: ScheduledSessionFire, availableAt: string, key: string) => {
    await options.queue.enqueue({
      name: SCHEDULED_SESSION_JOB,
      payload: fire,
      availableAt,
      idempotencyKey: key,
      concurrencyKey: `native-session:${fire.sessionFile}`,
      maxAttempts: 3,
    });
  };

  const sync = async (sessionFile: string, sessionManager?: SessionManager) => {
    const book = loadSessionScheduleBook(sessionManager ?? open(sessionFile));
    let queued = 0;
    for (const job of book.list()) {
      if (job.status !== "active" || job.nextRunAt === undefined) {
        continue;
      }
      await enqueue(
        { sessionFile, jobId: job.id, scheduledFor: job.nextRunAt },
        job.nextRunAt,
        `${sessionFile}:${job.id}:${job.nextRunAt}`,
      );
      queued += 1;
    }
    return queued;
  };

  const handle: ScheduledSessionService["handle"] = async (lease, signal) => {
    const fire = lease.payload;
    const busy =
      (openHere.get(fire.sessionFile) ?? 0) > 0 ||
      (await options.isSessionBusy?.(fire.sessionFile)) === true;
    if (busy) {
      const at = now() + busyRetryMs;
      await enqueue(
        fire,
        new Date(at).toISOString(),
        `${fire.sessionFile}:${fire.jobId}:${fire.scheduledFor}:busy:${at}`,
      );
      return { outcome: "busy", jobId: fire.jobId };
    }
    const sessionManager = open(fire.sessionFile);
    const book = loadSessionScheduleBook(sessionManager, { now });
    const job = book.get(fire.jobId);
    if (job === undefined || job.status !== "active" || job.nextRunAt !== fire.scheduledFor) {
      // The job was cancelled, paused, or already ran (live, or from an earlier fire).
      await sync(fire.sessionFile, sessionManager);
      return { outcome: "stale", jobId: fire.jobId };
    }
    const claimed = book.claimJob(fire.jobId);
    if (claimed === undefined) {
      await sync(fire.sessionFile, sessionManager);
      return { outcome: "stale", jobId: fire.jobId };
    }
    if (shouldDeferHeartbeat(claimed.job, {})) {
      book.recordSkip(fire.jobId);
      await sync(fire.sessionFile, sessionManager);
      return { outcome: "skipped", jobId: fire.jobId };
    }
    let error: string | undefined;
    const release = markOpen(fire.sessionFile);
    try {
      const result = await options.runSession({
        sessionFile: fire.sessionFile,
        sessionManager,
        prompt: scheduledPromptText(claimed.job),
        job: claimed.job,
        signal: signal ?? new AbortController().signal,
      });
      error = result?.failureMessage;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      release();
    }
    // The run may have changed the jobs (the agent can add or cancel them), so record on a fresh read.
    const after = loadSessionScheduleBook(sessionManager, { now });
    after.recordRun(fire.jobId, { error });
    await sync(fire.sessionFile, sessionManager);
    return {
      outcome: error === undefined ? "ran" : "failed",
      jobId: fire.jobId,
      ...(error === undefined ? {} : { error }),
    };
  };

  const markOpen = (sessionFile: string) => {
    openHere.set(sessionFile, (openHere.get(sessionFile) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = (openHere.get(sessionFile) ?? 1) - 1;
      if (count <= 0) {
        openHere.delete(sessionFile);
      } else {
        openHere.set(sessionFile, count);
      }
    };
  };

  return {
    sync,
    handle,
    markOpen,
    createWorker: (workerOptions = {}) =>
      createQueueWorker(options.queue, (lease, context) => handle(lease, context.signal), {
        ...workerOptions,
        names: [SCHEDULED_SESSION_JOB],
      }),
  };
}
