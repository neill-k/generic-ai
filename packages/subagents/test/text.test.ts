// Adapted from Prime Agent (PrimeIntellect-ai/prime-agent, crates/pa-daemon/src/rlm_child_model.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";

import {
  ANSWER_PREVIEW_MAX_CHARS,
  ANSWER_TEXT_MAX_CHARS,
  capText,
  childLabel,
  compactText,
  LABEL_MAX_CHARS,
} from "../src/index.js";

describe("roster text", () => {
  it("collapses and caps labels and previews", () => {
    expect(childLabel("  ship   the\nlane  ")).toBe("ship the lane");
    expect(childLabel("   ")).toBe("child agent");
    const label = childLabel("word ".repeat(100));
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
    expect(label.endsWith("...")).toBe(true);
    expect(compactText("  a\nshort   answer ")).toBe("a short answer");
    const preview = compactText("x".repeat(ANSWER_PREVIEW_MAX_CHARS + 50));
    expect(preview).toHaveLength(ANSWER_PREVIEW_MAX_CHARS);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("keeps far more of the full answer than the preview", () => {
    const capped = capText("y".repeat(ANSWER_TEXT_MAX_CHARS + 50), ANSWER_TEXT_MAX_CHARS);
    expect(capped).toHaveLength(ANSWER_TEXT_MAX_CHARS);
    expect(capped.endsWith("...")).toBe(true);
    const wide = `{"blob": "${"z".repeat(ANSWER_PREVIEW_MAX_CHARS * 4)}"}`;
    expect(capText(wide, ANSWER_TEXT_MAX_CHARS)).toBe(wide);
  });
});
