// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent, crates/pa-daemon/src/rlm_child_model.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

/** Cap on the one-line answer preview shown in rosters. */
export const ANSWER_PREVIEW_MAX_CHARS = 160;
/** Cap on the one-line task label shown in rosters. */
export const LABEL_MAX_CHARS = 200;
/** Cap on the full answer text a collect result carries. */
export const ANSWER_TEXT_MAX_CHARS = 65_536;

const ELLIPSIS = "...";

/** Number of Unicode code points, the unit Prime Agent counts in. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** `text` capped at `max` code points, ending in "..." when cut. */
export function capText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return `${chars
    .slice(0, max - ELLIPSIS.length)
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** Whitespace collapsed to single spaces and capped at the preview limit. */
export function compactText(text: string): string {
  return capText(collapseWhitespace(text), ANSWER_PREVIEW_MAX_CHARS);
}

/** One-line task label: the collapsed prompt, capped for roster rows. */
export function childLabel(prompt: string): string {
  const collapsed = collapseWhitespace(prompt);
  return capText(collapsed.length === 0 ? "child agent" : collapsed, LABEL_MAX_CHARS);
}
