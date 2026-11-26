/**
 * Usage and cost contracts.
 *
 * `ModelUsage` has the same shape as the usage the native model layer (`@generic-ai/ai`) reports on
 * every assistant message, so a response's usage can be passed through unchanged. Costs are in US
 * dollars and come from the model's per-million-token prices.
 */

export interface ModelUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface ModelUsage {
  /** Uncached input tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Reasoning tokens, when the provider reports them separately (already included in `output`). */
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: ModelUsageCost;
}

/** Data of a `usage.recorded` canonical event: one model response. */
export interface UsageRecordedEventData {
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  /** The agent that made the call. Defaults to the event's `sessionId` when rolled up. */
  readonly agentId?: string;
  /** The harness role the agent runs as (planner, builder, ...). */
  readonly roleId?: string;
  /** The goal this spend counts toward. */
  readonly goalId?: string;
  readonly responseId?: string;
  readonly stopReason?: string;
  /** Why the call was made, when it is not an agent turn (for example `compaction`). */
  readonly purpose?: string;
  readonly [key: string]: unknown;
}

export type UsageBudgetLimitKind = "tokens" | "cost_usd";

/** Token and dollar caps. A run is stopped once either total reaches its cap. */
export interface UsageBudgetLimits {
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

export interface UsageBudgetBreach {
  readonly limit: UsageBudgetLimitKind;
  readonly max: number;
  readonly used: number;
}

export interface UsageBudgetStatus {
  readonly exceeded: boolean;
  readonly breaches: readonly UsageBudgetBreach[];
  /** Tokens left before the cap, floored at 0. Absent when no token cap is set. */
  readonly remainingTokens?: number;
  /** Dollars left before the cap, floored at 0. Absent when no dollar cap is set. */
  readonly remainingCostUsd?: number;
}

/** Data of a `usage.budget.exceeded` canonical event. */
export interface UsageBudgetExceededEventData {
  readonly scope: "run";
  readonly breaches: readonly UsageBudgetBreach[];
  readonly limits: UsageBudgetLimits;
  readonly totals: UsageTotals;
  readonly [key: string]: unknown;
}

/** Summed usage over any set of responses. */
export interface UsageTotals {
  /** Number of model responses counted. */
  readonly responses: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly cost: ModelUsageCost;
}

export type GoalUsageOutcome = "open" | "completed" | "failed" | "cancelled";

export interface RunUsage {
  readonly runId: string;
  readonly totals: UsageTotals;
}

export interface AgentUsage {
  readonly runId: string;
  readonly agentId: string;
  readonly roleId?: string;
  readonly totals: UsageTotals;
}

export interface GoalUsage {
  readonly goalId: string;
  readonly outcome: GoalUsageOutcome;
  readonly totals: UsageTotals;
}

export interface ModelUsageRollup {
  readonly provider: string;
  readonly model: string;
  readonly totals: UsageTotals;
}

/**
 * The headline efficiency figures. `tokensPerCompletedGoal` divides every token spent on goals
 * (including goals that failed, were cancelled, or are still open) by the number of goals that
 * completed, so wasted attempts make the number worse, as they should.
 */
export interface GoalEfficiency {
  readonly goalCount: number;
  readonly completedGoals: number;
  readonly failedGoals: number;
  readonly cancelledGoals: number;
  readonly openGoals: number;
  readonly goalTokens: number;
  readonly goalCostUsd: number;
  readonly tokensPerCompletedGoal: number | null;
  readonly costPerCompletedGoalUsd: number | null;
}

export interface UsageSummary {
  readonly totals: UsageTotals;
  readonly goals: GoalEfficiency;
  readonly byRun: readonly RunUsage[];
  readonly byAgent: readonly AgentUsage[];
  readonly byGoal: readonly GoalUsage[];
  readonly byModel: readonly ModelUsageRollup[];
}
