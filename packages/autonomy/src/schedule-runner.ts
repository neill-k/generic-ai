// The wake-timer loop over one schedule book, adapted from Prime Agent's cron scheduler
// (`crates/pa-core/src/cron/scheduler.rs`, PrimeIntellect-ai/prime-agent): the timer sleeps until
// the earliest next run, a pass claims every due job and runs them one at a time (one session is one
// dispatch lane), and a change to the book re-arms the timer.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { ClaimedJob, ScheduleBook, ScheduledJob } from "./schedules.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export type ScheduledRunOutcome = "ran" | "skipped";

export interface ScheduleRunnerOptions {
  readonly book: ScheduleBook;
  /** Runs one claimed job. Return `skipped` for a deferred heartbeat; throw when the run fails. */
  readonly run: (claimed: ClaimedJob) => Promise<ScheduledRunOutcome> | ScheduledRunOutcome;
  readonly onError?: ((job: ScheduledJob, error: unknown) => void) | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Whether jobs can be delivered now. While it returns false, due jobs stay unclaimed and the
   * runner checks again after `retryMs`.
   */
  readonly ready?: (() => boolean) | undefined;
  /** Default 1000. */
  readonly retryMs?: number | undefined;
}

export class ScheduleRunner {
  readonly #options: ScheduleRunnerOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pass: Promise<number> | undefined;
  #started = false;
  #busy = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: ScheduleRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get running(): boolean {
    return this.#started;
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#unsubscribe = this.#options.book.onChange(() => this.#arm());
    this.#arm();
  }

  /** Stops the timer and waits for a pass in flight. */
  async stop(): Promise<void> {
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#clear();
    await this.#pass;
  }

  /** Runs every due job now. Returns how many ran (skips not counted). */
  runDue(): Promise<number> {
    if (this.#pass !== undefined) {
      return this.#pass;
    }
    this.#clear();
    this.#busy = true;
    const pass = this.#runPass().finally(() => {
      this.#busy = false;
      this.#pass = undefined;
      this.#arm();
    });
    this.#pass = pass;
    return pass;
  }

  async #runPass(): Promise<number> {
    const { book } = this.#options;
    if (this.#options.ready?.() === false) {
      return 0;
    }
    let ran = 0;
    for (const claimed of book.claimDue(this.#now())) {
      let outcome: ScheduledRunOutcome;
      try {
        outcome = await this.#options.run(claimed);
      } catch (error) {
        this.#options.onError?.(claimed.job, error);
        book.recordRun(claimed.job.id, {
          error: error instanceof Error ? error.message : String(error),
        });
        ran += 1;
        continue;
      }
      if (outcome === "skipped") {
        book.recordSkip(claimed.job.id);
      } else {
        book.recordRun(claimed.job.id);
        ran += 1;
      }
    }
    return ran;
  }

  #clear(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #arm(): void {
    this.#clear();
    if (!this.#started || this.#busy) {
      return;
    }
    const wakeAt = this.#options.book.nextWakeAt();
    if (wakeAt === undefined) {
      return;
    }
    let delay = Math.min(Math.max(0, wakeAt - this.#now()), MAX_TIMEOUT_MS);
    if (delay === 0 && this.#options.ready?.() === false) {
      delay = this.#options.retryMs ?? 1000;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runDue();
    }, delay);
  }
}
