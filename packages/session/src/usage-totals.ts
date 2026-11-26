// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/usage-totals.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { addUsage, type Usage } from "@generic-ai/ai";
import type { SessionEntry } from "./session-manager.js";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function createUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

/** Sum of two usages, keeping the reasoning split when either side reports it. */
export function combineUsage(first: Usage, second: Usage): Usage {
  return addUsage(first, second);
}

export interface UsageCostBreakdownEntry {
  key: string;
  cost: number;
  tokens: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
  const totalsByKey = new Map<string, UsageTotals>();

  for (const entry of entries) {
    let key: string | undefined;
    let usage: Usage | undefined;
    if (entry.type === "message" && entry.message.role === "assistant") {
      key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
      usage = entry.message.usage;
    } else if (entry.type === "usage") {
      key = `${entry.provider}/${entry.model}`;
      usage = entry.usage;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      key = "Tools/summaries";
      usage = entry.message.usage;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      key = "Tools/summaries";
      usage = entry.usage;
    }
    if (!key || !usage) continue;

    let totals = totalsByKey.get(key);
    if (!totals) {
      totals = createUsageTotals();
      totalsByKey.set(key, totals);
    }
    addUsageToTotals(totals, usage);
  }

  return Array.from(totalsByKey, ([key, totals]) => ({
    key,
    cost: totals.cost,
    tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
  }))
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
}
