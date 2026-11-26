// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent,
// crates/pa-core/src/session_engine/rlm_host.rs, progress_note_throttles_and_stores).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";

import {
  normalizeProgressNote,
  PROGRESS_NOTE_MIN_INTERVAL_MS,
  ProgressNotes,
} from "../src/index.js";

describe("progress notes", () => {
  it("throttles and stores notes", () => {
    let now = 1_000_000;
    const notes = new ProgressNotes({ now: () => now });
    expect(notes.note(normalizeProgressNote("  making progress  "))).toEqual({ accepted: true });
    expect(notes.latest()?.message).toBe("making progress");
    notes.clear();
    expect(notes.latest()).toBeUndefined();
    // Clearing does not reset the interval.
    expect(notes.note("too soon").accepted).toBe(false);
    now += 4_000;
    const throttled = notes.note("again");
    expect(throttled).toEqual({
      accepted: false,
      retryAfterMs: PROGRESS_NOTE_MIN_INTERVAL_MS - 4_000,
    });
    now += 6_000;
    expect(notes.note("later")).toEqual({ accepted: true });
    expect(notes.latest()).toEqual({ message: "later", at: now });
  });

  it("validates empty and oversized notes", () => {
    expect(() => normalizeProgressNote("  ")).toThrow(
      "progress_note message must be a non-empty string",
    );
    expect(() => normalizeProgressNote(42)).toThrow(
      "progress_note message must be a non-empty string",
    );
    // 513 astral characters are 1,026 UTF-16 units.
    expect(() => normalizeProgressNote("\u{1F600}".repeat(513))).toThrow(
      "progress_note message must be at most 512 characters",
    );
    expect(normalizeProgressNote("x".repeat(512))).toHaveLength(512);
  });
});
