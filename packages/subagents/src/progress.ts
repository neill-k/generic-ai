// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent,
// crates/pa-core/src/session_engine/rlm_host.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

/** Longest progress note, in UTF-16 code units. */
export const PROGRESS_NOTE_MAX_LENGTH = 512;
/** Shortest gap between two accepted progress notes. */
export const PROGRESS_NOTE_MIN_INTERVAL_MS = 10_000;

export type ProgressNoteOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly retryAfterMs: number };

/** Trim a progress note and check it is non-empty and at most 512 UTF-16 code units. */
export function normalizeProgressNote(raw: unknown, operation = "progress_note"): string {
  const message = typeof raw === "string" ? raw.trim() : "";
  if (message.length === 0) {
    throw new Error(`${operation} message must be a non-empty string`);
  }
  if (message.length > PROGRESS_NOTE_MAX_LENGTH) {
    throw new Error(`${operation} message must be at most ${PROGRESS_NOTE_MAX_LENGTH} characters`);
  }
  return message;
}

/**
 * The latest progress note of one agent. Notes closer together than the minimum interval are
 * refused with the time left; clearing the note does not reset the interval.
 */
export class ProgressNotes {
  readonly #now: () => number;
  readonly #minIntervalMs: number;
  #latest: { readonly message: string; readonly at: number } | undefined;
  #lastAcceptedAt: number | undefined;

  constructor(options: { now?: () => number; minIntervalMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#minIntervalMs = options.minIntervalMs ?? PROGRESS_NOTE_MIN_INTERVAL_MS;
  }

  note(message: string): ProgressNoteOutcome {
    const now = this.#now();
    if (this.#lastAcceptedAt !== undefined) {
      const elapsed = now - this.#lastAcceptedAt;
      if (elapsed < this.#minIntervalMs) {
        return { accepted: false, retryAfterMs: this.#minIntervalMs - elapsed };
      }
    }
    this.#lastAcceptedAt = now;
    this.#latest = { message, at: now };
    return { accepted: true };
  }

  latest(): { readonly message: string; readonly at: number } | undefined {
    return this.#latest;
  }

  clear(): void {
    this.#latest = undefined;
  }
}
