import type { Usage } from "@generic-ai/ai";
import { describe, expect, it } from "vitest";

import { combineUsage } from "../src/usage-totals.js";

function usage(tokens: number, cost: number, reasoning?: number): Usage {
  return {
    input: tokens,
    output: tokens,
    cacheRead: 1,
    cacheWrite: 2,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: tokens * 2 + 3,
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0, total: cost * 2 },
  };
}

describe("combineUsage", () => {
  it("adds token counts and costs", () => {
    const combined = combineUsage(usage(10, 1), usage(5, 0.5));
    expect(combined).toMatchObject({
      input: 15,
      output: 15,
      cacheRead: 2,
      cacheWrite: 4,
      totalTokens: 36,
      cost: { input: 1.5, output: 1.5, total: 3 },
    });
    expect(combined.reasoning).toBeUndefined();
  });

  it("keeps the reasoning split when either side reports it", () => {
    expect(combineUsage(usage(1, 0, 7), usage(1, 0)).reasoning).toBe(7);
  });
});
