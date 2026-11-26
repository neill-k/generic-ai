import {
  type AgentHarnessBudget,
  addUsageTotals,
  emptyUsageTotals,
  evaluateUsageBudget,
  formatUsageBudgetBreach,
  hasUsageBudget,
  type ModelUsage,
  type UsageBudgetLimits,
  type UsageBudgetStatus,
  type UsageTotals,
  usageTotalsFromModelUsage,
} from "@generic-ai/sdk";

/**
 * A spend cap shared by everything one eval run does (roadmap R19): every agent turn of every
 * attempt of every template, and every rubric judgment. It reuses the run budgets already on
 * main: each turn starts with a harness budget equal to what is left of the cap, so the harness
 * stops a turn mid-flight with `budget_exceeded` once the cap is reached, and the eval runner
 * skips the attempts that have not started yet.
 */
export interface SpendCap {
  readonly limits: UsageBudgetLimits;
  /** Adds usage that has already been spent. */
  record(totals: UsageTotals): void;
  /** Adds one model response's usage. */
  recordModelUsage(usage: ModelUsage): void;
  spent(): UsageTotals;
  status(): UsageBudgetStatus;
  /** True once either total has reached its cap. */
  exhausted(): boolean;
  /** What is left, as a harness budget for the next turn. Undefined when no cap is set. */
  turnBudget(): AgentHarnessBudget | undefined;
  /** A sentence on why work stopped, or undefined while the cap still has room. */
  reason(): string | undefined;
}

export function createSpendCap(limits: UsageBudgetLimits = {}): SpendCap {
  let spent: UsageTotals = emptyUsageTotals;
  const status = () => evaluateUsageBudget(spent, limits);
  return {
    limits,
    record(totals) {
      spent = addUsageTotals(spent, totals);
    },
    recordModelUsage(usage) {
      spent = addUsageTotals(spent, usageTotalsFromModelUsage(usage));
    },
    spent: () => spent,
    status,
    exhausted: () => status().exceeded,
    turnBudget() {
      if (!hasUsageBudget(limits)) {
        return undefined;
      }
      const current = status();
      return {
        ...(current.remainingTokens === undefined ? {} : { maxTokens: current.remainingTokens }),
        ...(current.remainingCostUsd === undefined ? {} : { maxCostUsd: current.remainingCostUsd }),
      };
    },
    reason() {
      const current = status();
      return current.exceeded
        ? `The eval spend cap was reached (${current.breaches.map(formatUsageBudgetBreach).join("; ")}).`
        : undefined;
    },
  };
}
