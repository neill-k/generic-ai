// Scheduled prompts and heartbeats for one session. Adapted from Prime Agent's cron job store and
// scheduler (`crates/pa-core/src/cron/store`, `cron/scheduler.rs`, PrimeIntellect-ai/prime-agent):
// a claim advances a job before it runs so a slow run is never claimed twice, one-shot jobs complete
// after their run, a skipped run rolls to the next slot, at most one heartbeat is live per session,
// and consecutive failures back off from two minutes to one hour.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { randomBytes } from "node:crypto";

import {
  DEFAULT_HEARTBEAT_DELIVERY_MODE,
  type DeliveryMode,
  nextRunAfter,
  normalizeHeartbeatSchedule,
  parseSchedule,
  type Schedule,
} from "./schedule.js";

export type ScheduledJobStatus = "active" | "paused" | "completed" | "cancelled";
/** `cron` jobs are prompts the agent or host scheduled; a `heartbeat` is the session's recurring check-in. */
export type ScheduledJobSource = "cron" | "heartbeat";

export interface ScheduledJob {
  readonly id: string;
  readonly status: ScheduledJobStatus;
  readonly source: ScheduledJobSource;
  readonly deliveryMode?: DeliveryMode;
  readonly label?: string;
  readonly prompt: string;
  readonly schedule: Schedule;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastSkippedAt?: string;
  readonly lastError?: string;
  readonly runCount: number;
  readonly failureStreak: number;
}

/** A job claimed for a run, with the slot it was due at. */
export interface ClaimedJob {
  readonly job: ScheduledJob;
  readonly scheduledFor: string;
}

export interface ScheduleBookState {
  readonly version: 1;
  readonly jobs: readonly ScheduledJob[];
}

/** Session custom-entry type that holds a session's schedule book. */
export const SCHEDULES_CUSTOM_TYPE = "scheduled_jobs_state";

const FAILURE_BACKOFF_BASE_MS = 120_000;
const FAILURE_BACKOFF_CAP_MS = 3_600_000;
const ONE_SHOT_SKIP_RETRY_MS = 60_000;

/** The delay before a failing job's next run: two minutes, doubling, at most one hour. */
export function failureBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    FAILURE_BACKOFF_CAP_MS,
  );
}

/** What a session is doing when a heartbeat comes due. */
export interface SessionActivity {
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly isRetrying?: boolean;
  readonly isBashRunning?: boolean;
  readonly hasPendingSessionWork?: boolean;
  readonly unfinishedActionCount?: number;
}

/**
 * Whether a due heartbeat waits for its next slot instead of interrupting. Scheduled prompts always
 * run. A heartbeat waits while the session compacts, retries, runs a command or has queued work; a
 * mid-turn session takes a steer heartbeat but not a follow-up one.
 */
export function shouldDeferHeartbeat(job: ScheduledJob, activity: SessionActivity): boolean {
  if (job.source !== "heartbeat") {
    return false;
  }
  const streaming = activity.isStreaming === true;
  if (
    activity.isCompacting === true ||
    activity.isRetrying === true ||
    activity.isBashRunning === true ||
    activity.hasPendingSessionWork === true ||
    (!streaming && (activity.unfinishedActionCount ?? 0) > 0)
  ) {
    return true;
  }
  return (job.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE) === "steer" ? false : streaming;
}

export function isDueJob(job: ScheduledJob, now: number): boolean {
  return job.status === "active" && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= now;
}

/** One line per job, as `cron_list` shows it. */
export function formatScheduledJob(job: ScheduledJob): string {
  const preview = job.prompt.split(/\s+/).filter(Boolean).join(" ");
  return [
    `${job.id} ${job.status}`,
    job.source === "heartbeat" ? " heartbeat" : "",
    job.label === undefined ? "" : ` label="${job.label}"`,
    ` next=${job.nextRunAt ?? "-"} last=${job.lastRunAt ?? "-"}`,
    job.lastSkippedAt === undefined ? "" : ` skipped=${job.lastSkippedAt}`,
    ` runs=${job.runCount} schedule="${job.schedule.expression}" prompt="${[...preview].slice(0, 80).join("")}"`,
    job.lastError === undefined ? "" : ` error=${job.lastError}`,
  ].join("");
}

/** The text a scheduled job delivers to the agent. */
export function scheduledPromptText(job: ScheduledJob): string {
  const name = job.label === undefined ? job.id : `${job.id} "${job.label}"`;
  return job.source === "heartbeat"
    ? `[heartbeat ${name}, ${job.schedule.expression}]\n${job.prompt}`
    : `[scheduled job ${name}, ${job.schedule.expression}]\n${job.prompt}`;
}

export function isScheduleBookState(value: unknown): value is ScheduleBookState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { jobs?: unknown }).jobs)
  );
}

export interface ScheduleBookOptions {
  readonly state?: ScheduleBookState | undefined;
  /** Called with the whole book after every change. */
  readonly persist?: ((state: ScheduleBookState) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  /** Called after every change, for example to re-arm a timer. */
  readonly onChange?: (() => void) | undefined;
}

export interface AddScheduledJobInput {
  readonly prompt: string;
  /** `in 10m`, `at <ISO date>`, `every 5m`, `@daily` or five cron fields (UTC). */
  readonly schedule: string;
  readonly label?: string | undefined;
}

export interface SetHeartbeatInput {
  readonly instruction: string;
  /** A recurring schedule. Defaults to `every 5m`; `10m` means `every 10m`. */
  readonly schedule?: string | undefined;
  readonly deliveryMode?: DeliveryMode | undefined;
  readonly label?: string | undefined;
}

export type HeartbeatAction = "pause" | "resume" | "stop";

function iso(millis: number): string {
  return new Date(millis).toISOString();
}

function label(value: string | undefined): { label?: string } {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { label: trimmed };
}

/** The scheduled prompts and heartbeat of one session. */
export class ScheduleBook {
  #jobs: ScheduledJob[];
  readonly #persist: ScheduleBookOptions["persist"];
  readonly #now: () => number;
  readonly #newId: () => string;
  #onChange: (() => void) | undefined;

  constructor(options: ScheduleBookOptions = {}) {
    this.#jobs = [...(options.state?.jobs ?? [])];
    this.#persist = options.persist;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomBytes(4).toString("hex"));
    this.#onChange = options.onChange;
  }

  /** Replaces the change listener; returns a function that removes it. */
  onChange(listener: () => void): () => void {
    this.#onChange = listener;
    return () => {
      if (this.#onChange === listener) {
        this.#onChange = undefined;
      }
    };
  }

  get state(): ScheduleBookState {
    return { version: 1, jobs: [...this.#jobs] };
  }

  get(id: string): ScheduledJob | undefined {
    return this.#jobs.find((job) => job.id === id);
  }

  /** Jobs ordered by next run, without finished ones unless asked. */
  list(options: { readonly includeInactive?: boolean } = {}): ScheduledJob[] {
    return this.#jobs
      .filter(
        (job) =>
          options.includeInactive === true || job.status === "active" || job.status === "paused",
      )
      .sort((left, right) => {
        if (left.nextRunAt === undefined) {
          return right.nextRunAt === undefined ? 0 : 1;
        }
        return right.nextRunAt === undefined ? -1 : left.nextRunAt.localeCompare(right.nextRunAt);
      });
  }

  /** The live (active or paused) heartbeat, if any. */
  heartbeat(): ScheduledJob | undefined {
    return this.#jobs.find(
      (job) => job.source === "heartbeat" && (job.status === "active" || job.status === "paused"),
    );
  }

  add(input: AddScheduledJobInput): ScheduledJob {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new Error("Scheduled prompt cannot be empty");
    }
    const now = this.#now();
    const parsed = parseSchedule(input.schedule, now);
    const job: ScheduledJob = {
      id: this.#uniqueId(),
      status: "active",
      source: "cron",
      ...label(input.label),
      prompt,
      schedule: parsed.schedule,
      createdAt: iso(now),
      updatedAt: iso(now),
      nextRunAt: iso(parsed.nextRunAt),
      runCount: 0,
      failureStreak: 0,
    };
    this.#write([...this.#jobs, job]);
    return job;
  }

  /** Starts the session's heartbeat, replacing a live one. */
  setHeartbeat(input: SetHeartbeatInput): ScheduledJob {
    const prompt = input.instruction.trim();
    if (prompt.length === 0) {
      throw new Error("Heartbeat instruction cannot be empty");
    }
    const now = this.#now();
    const parsed = parseSchedule(normalizeHeartbeatSchedule(input.schedule), now);
    if (parsed.schedule.kind === "once") {
      throw new Error("Heartbeat schedule must be recurring");
    }
    const job: ScheduledJob = {
      id: this.#uniqueId(),
      status: "active",
      source: "heartbeat",
      deliveryMode: input.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
      ...label(input.label),
      prompt,
      schedule: parsed.schedule,
      createdAt: iso(now),
      updatedAt: iso(now),
      nextRunAt: iso(parsed.nextRunAt),
      runCount: 0,
      failureStreak: 0,
    };
    const jobs = this.#jobs.map((existing): ScheduledJob => {
      if (
        existing.source !== "heartbeat" ||
        (existing.status !== "active" && existing.status !== "paused")
      ) {
        return existing;
      }
      const { nextRunAt: _next, ...rest } = existing;
      return { ...rest, status: "cancelled", updatedAt: iso(now) };
    });
    this.#write([...jobs, job]);
    return job;
  }

  /** Pauses, resumes or stops the live heartbeat. Returns it, or undefined when there is none. */
  manageHeartbeat(action: HeartbeatAction): ScheduledJob | undefined {
    const current = this.heartbeat();
    if (current === undefined) {
      return undefined;
    }
    const now = this.#now();
    const { nextRunAt: _next, ...rest } = current;
    let updated: ScheduledJob;
    if (action === "resume") {
      const next = nextRunAfter(current.schedule, now);
      if (next === undefined) {
        throw new Error("Heartbeat schedule must be recurring");
      }
      updated = { ...rest, status: "active", nextRunAt: iso(next), updatedAt: iso(now) };
    } else {
      updated = {
        ...rest,
        status: action === "pause" ? "paused" : "cancelled",
        updatedAt: iso(now),
      };
    }
    this.#replace(updated);
    return updated;
  }

  /** Cancels a job. Returns it, or undefined when no active or paused job has that id. */
  cancel(id: string): ScheduledJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status === "completed" || job.status === "cancelled") {
      return undefined;
    }
    const { nextRunAt: _next, ...rest } = job;
    const updated: ScheduledJob = { ...rest, status: "cancelled", updatedAt: iso(this.#now()) };
    this.#replace(updated);
    return updated;
  }

  due(now = this.#now()): ScheduledJob[] {
    return this.#jobs.filter((job) => isDueJob(job, now));
  }

  /** The earliest next run of an active job, in epoch milliseconds. */
  nextWakeAt(): number | undefined {
    let earliest: number | undefined;
    for (const job of this.#jobs) {
      if (job.status === "active" && job.nextRunAt !== undefined) {
        const at = Date.parse(job.nextRunAt);
        earliest = earliest === undefined ? at : Math.min(earliest, at);
      }
    }
    return earliest;
  }

  /**
   * Claims every due job: each one's next run moves to its following slot before it runs, so a run
   * that outlasts its interval is not claimed again. Missed slots are not replayed.
   */
  claimDue(now = this.#now()): ClaimedJob[] {
    return this.#claim((job) => isDueJob(job, now), now);
  }

  /** Claims one job if it is due, as `claimDue` would. */
  claimJob(id: string, now = this.#now()): ClaimedJob | undefined {
    return this.#claim((job) => job.id === id && isDueJob(job, now), now)[0];
  }

  #claim(select: (job: ScheduledJob) => boolean, now: number): ClaimedJob[] {
    const claimed: ClaimedJob[] = [];
    const jobs = this.#jobs.map((job): ScheduledJob => {
      if (!select(job) || job.nextRunAt === undefined) {
        return job;
      }
      const { nextRunAt: scheduledFor, ...rest } = job;
      const next = nextRunAfter(job.schedule, now);
      const updated: ScheduledJob = {
        ...rest,
        ...(next === undefined ? {} : { nextRunAt: iso(next) }),
        updatedAt: iso(now),
      };
      claimed.push({ job: updated, scheduledFor });
      return updated;
    });
    if (claimed.length > 0) {
      this.#write(jobs);
    }
    return claimed;
  }

  /** Records a run: a one-shot job completes, and a failure pushes the next run back. */
  recordRun(
    id: string,
    result: { readonly error?: string | undefined } = {},
  ): ScheduledJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "active") {
      return job;
    }
    const now = this.#now();
    const { nextRunAt: _next, lastError: _error, ...rest } = job;
    const failureStreak = result.error === undefined ? 0 : job.failureStreak + 1;
    let next = nextRunAfter(job.schedule, now);
    if (next !== undefined && result.error !== undefined) {
      next = Math.max(next, now + failureBackoffMs(failureStreak));
    }
    const updated: ScheduledJob = {
      ...rest,
      status: job.schedule.kind === "once" ? "completed" : "active",
      ...(next === undefined ? {} : { nextRunAt: iso(next) }),
      lastRunAt: iso(now),
      ...(result.error === undefined ? {} : { lastError: result.error }),
      runCount: job.runCount + 1,
      failureStreak,
      updatedAt: iso(now),
    };
    this.#replace(updated);
    return updated;
  }

  /** Records a skipped run (a deferred heartbeat): the job waits for its next slot. */
  recordSkip(id: string): ScheduledJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "active") {
      return job;
    }
    const now = this.#now();
    const next = nextRunAfter(job.schedule, now) ?? now + ONE_SHOT_SKIP_RETRY_MS;
    const updated: ScheduledJob = {
      ...job,
      nextRunAt: iso(next),
      lastSkippedAt: iso(now),
      updatedAt: iso(now),
    };
    this.#replace(updated);
    return updated;
  }

  #uniqueId(): string {
    for (;;) {
      const id = this.#newId();
      if (this.get(id) === undefined) {
        return id;
      }
    }
  }

  #replace(updated: ScheduledJob): void {
    this.#write(this.#jobs.map((job) => (job.id === updated.id ? updated : job)));
  }

  #write(jobs: ScheduledJob[]): void {
    this.#jobs = jobs;
    this.#persist?.(this.state);
    this.#onChange?.();
  }
}
