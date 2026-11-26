import type { CanonicalEvent } from "../events/index.js";
import type {
  AgentUsage,
  GoalEfficiency,
  GoalUsage,
  GoalUsageOutcome,
  ModelUsage,
  ModelUsageCost,
  ModelUsageRollup,
  RunUsage,
  UsageBudgetBreach,
  UsageBudgetLimits,
  UsageBudgetStatus,
  UsageRecordedEventData,
  UsageSummary,
  UsageTotals,
} from "./types.js";

const ZERO_COST: ModelUsageCost = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export const emptyUsageTotals: UsageTotals = Object.freeze({
  responses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  cost: ZERO_COST,
});

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The token count of one response: the provider's total, or the sum of its parts when absent. */
export function modelUsageTokens(usage: ModelUsage): number {
  const total = finiteNonNegative(usage.totalTokens);
  if (total > 0) {
    return total;
  }
  return (
    finiteNonNegative(usage.input) +
    finiteNonNegative(usage.output) +
    finiteNonNegative(usage.cacheRead) +
    finiteNonNegative(usage.cacheWrite)
  );
}

/** Totals for a single response. */
export function usageTotalsFromModelUsage(usage: ModelUsage): UsageTotals {
  const cost = Object.freeze({
    input: finiteNonNegative(usage.cost?.input),
    output: finiteNonNegative(usage.cost?.output),
    cacheRead: finiteNonNegative(usage.cost?.cacheRead),
    cacheWrite: finiteNonNegative(usage.cost?.cacheWrite),
    total: finiteNonNegative(usage.cost?.total),
  });
  const costUsd =
    cost.total > 0 ? cost.total : cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return Object.freeze({
    responses: 1,
    inputTokens: finiteNonNegative(usage.input),
    outputTokens: finiteNonNegative(usage.output),
    cacheReadTokens: finiteNonNegative(usage.cacheRead),
    cacheWriteTokens: finiteNonNegative(usage.cacheWrite),
    reasoningTokens: finiteNonNegative(usage.reasoning),
    totalTokens: modelUsageTokens(usage),
    costUsd,
    cost: Object.freeze({ ...cost, total: costUsd }),
  });
}

export function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return Object.freeze({
    responses: left.responses + right.responses,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    cost: Object.freeze({
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    }),
  });
}

function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Compare totals with token and dollar caps. A cap counts as exceeded once the total reaches it,
 * so `maxTokens: 1000` stops a run at its first response that brings the total to 1000 or more.
 */
export function evaluateUsageBudget(
  totals: UsageTotals,
  limits: UsageBudgetLimits | undefined,
): UsageBudgetStatus {
  const maxTokens = positiveLimit(limits?.maxTokens);
  const maxCostUsd = positiveLimit(limits?.maxCostUsd);
  const breaches: UsageBudgetBreach[] = [];
  if (maxTokens !== undefined && totals.totalTokens >= maxTokens) {
    breaches.push(Object.freeze({ limit: "tokens", max: maxTokens, used: totals.totalTokens }));
  }
  if (maxCostUsd !== undefined && totals.costUsd >= maxCostUsd) {
    breaches.push(Object.freeze({ limit: "cost_usd", max: maxCostUsd, used: totals.costUsd }));
  }
  return Object.freeze({
    exceeded: breaches.length > 0,
    breaches: Object.freeze(breaches),
    ...(maxTokens === undefined
      ? {}
      : { remainingTokens: Math.max(0, maxTokens - totals.totalTokens) }),
    ...(maxCostUsd === undefined
      ? {}
      : { remainingCostUsd: Math.max(0, maxCostUsd - totals.costUsd) }),
  });
}

/** True when `limits` sets at least one usable cap. */
export function hasUsageBudget(limits: UsageBudgetLimits | undefined): boolean {
  return (
    positiveLimit(limits?.maxTokens) !== undefined ||
    positiveLimit(limits?.maxCostUsd) !== undefined
  );
}

export function formatUsageBudgetBreach(breach: UsageBudgetBreach): string {
  return breach.limit === "tokens"
    ? `token budget reached (${breach.used} of ${breach.max} tokens)`
    : `cost budget reached ($${breach.used.toFixed(4)} of $${breach.max.toFixed(4)})`;
}

/** One model response, as the ledger records it. */
export interface UsageLedgerRecordInput {
  readonly runId: string;
  readonly sessionId?: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly agentId?: string;
  readonly roleId?: string;
  readonly goalId?: string;
}

export interface UsageLedger {
  /** Count one model response. Returns the run's new totals. */
  record(input: UsageLedgerRecordInput): UsageTotals;
  /**
   * Feed a canonical event. `usage.recorded` events are counted; goal outcomes are taken from
   * `goal.completed` / `goal.failed` / `goal.cancelled` (core or plugin namespaced, for example
   * `plugin.goals.goal.completed`) and from terminal `run.*` events whose data carries a `goalId`.
   * A `goalId` on `run.created` or `run.started` attributes that run's later usage to the goal.
   * Other events are ignored.
   */
  observe(event: CanonicalEvent): void;
  /** Attribute every later response of `runId` that has no goal of its own to `goalId`. */
  assignRunToGoal(runId: string, goalId: string): void;
  setGoalOutcome(goalId: string, outcome: GoalUsageOutcome): void;
  runTotals(runId: string): UsageTotals;
  totals(): UsageTotals;
  summary(): UsageSummary;
}

interface MutableGoal {
  outcome: GoalUsageOutcome;
  totals: UsageTotals;
}

const GOAL_OUTCOME_SUFFIXES: readonly (readonly [string, GoalUsageOutcome])[] = [
  ["goal.completed", "completed"],
  ["goal.failed", "failed"],
  ["goal.cancelled", "cancelled"],
];

const RUN_OUTCOMES: Readonly<Record<string, GoalUsageOutcome>> = Object.freeze({
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
});

function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function goalOutcomeForEventName(name: string): GoalUsageOutcome | undefined {
  for (const [suffix, outcome] of GOAL_OUTCOME_SUFFIXES) {
    if (name === suffix || name.endsWith(`.${suffix}`)) {
      return outcome;
    }
  }
  return RUN_OUTCOMES[name];
}

function isModelUsage(value: unknown): value is ModelUsage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ModelUsage>;
  return (
    typeof candidate.input === "number" &&
    typeof candidate.output === "number" &&
    typeof candidate.cost === "object" &&
    candidate.cost !== null
  );
}

/** Read the data of a `usage.recorded` event, or undefined when it is malformed. */
export function readUsageRecordedEventData(
  event: Pick<CanonicalEvent, "name" | "data">,
): UsageRecordedEventData | undefined {
  if (event.name !== "usage.recorded") {
    return undefined;
  }
  const data = event.data;
  const provider = stringField(data, "provider");
  const model = stringField(data, "model");
  if (provider === undefined || model === undefined || !isModelUsage(data["usage"])) {
    return undefined;
  }
  return data as UsageRecordedEventData;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Roll model usage up per run, per agent, per goal, and per model. The ledger is in memory and
 * deterministic: summaries are sorted by id so two ledgers fed the same events produce equal
 * summaries.
 */
export function createUsageLedger(): UsageLedger {
  let totals = emptyUsageTotals;
  const runs = new Map<string, UsageTotals>();
  const agents = new Map<string, AgentUsage>();
  const goals = new Map<string, MutableGoal>();
  const models = new Map<string, ModelUsageRollup>();
  const runGoals = new Map<string, string>();

  const goal = (goalId: string): MutableGoal => {
    let entry = goals.get(goalId);
    if (entry === undefined) {
      entry = { outcome: "open", totals: emptyUsageTotals };
      goals.set(goalId, entry);
    }
    return entry;
  };

  const ledger: UsageLedger = {
    record(input) {
      const response = usageTotalsFromModelUsage(input.usage);
      totals = addUsageTotals(totals, response);
      const runTotals = addUsageTotals(runs.get(input.runId) ?? emptyUsageTotals, response);
      runs.set(input.runId, runTotals);

      const agentId = input.agentId ?? input.sessionId ?? "unknown";
      const agentKey = `${input.runId}\u0000${agentId}`;
      const agent = agents.get(agentKey);
      agents.set(
        agentKey,
        Object.freeze({
          runId: input.runId,
          agentId,
          ...((agent?.roleId ?? input.roleId) === undefined
            ? {}
            : { roleId: (agent?.roleId ?? input.roleId) as string }),
          totals: addUsageTotals(agent?.totals ?? emptyUsageTotals, response),
        }),
      );

      const goalId = input.goalId ?? runGoals.get(input.runId);
      if (goalId !== undefined) {
        const entry = goal(goalId);
        entry.totals = addUsageTotals(entry.totals, response);
      }

      const modelKey = `${input.provider}/${input.model}`;
      models.set(
        modelKey,
        Object.freeze({
          provider: input.provider,
          model: input.model,
          totals: addUsageTotals(models.get(modelKey)?.totals ?? emptyUsageTotals, response),
        }),
      );
      return runTotals;
    },
    observe(event) {
      const usage = readUsageRecordedEventData(event);
      if (usage !== undefined) {
        ledger.record({
          runId: event.runId,
          sessionId: event.sessionId,
          provider: usage.provider,
          model: usage.model,
          usage: usage.usage,
          ...(usage.agentId === undefined ? {} : { agentId: usage.agentId }),
          ...(usage.roleId === undefined ? {} : { roleId: usage.roleId }),
          ...(usage.goalId === undefined ? {} : { goalId: usage.goalId }),
        });
        return;
      }
      const goalId = stringField(event.data, "goalId");
      if (goalId === undefined) {
        return;
      }
      if (event.name === "run.created" || event.name === "run.started") {
        ledger.assignRunToGoal(event.runId, goalId);
        return;
      }
      const outcome = goalOutcomeForEventName(event.name);
      if (outcome !== undefined) {
        ledger.setGoalOutcome(goalId, outcome);
      }
    },
    assignRunToGoal(runId, goalId) {
      runGoals.set(runId, goalId);
      goal(goalId);
    },
    setGoalOutcome(goalId, outcome) {
      goal(goalId).outcome = outcome;
    },
    runTotals(runId) {
      return runs.get(runId) ?? emptyUsageTotals;
    },
    totals() {
      return totals;
    },
    summary() {
      const byGoal: GoalUsage[] = [...goals.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([goalId, entry]) =>
          Object.freeze({ goalId, outcome: entry.outcome, totals: entry.totals }),
        );
      return Object.freeze({
        totals,
        goals: goalEfficiency(byGoal),
        byRun: Object.freeze(
          [...runs.entries()]
            .sort(([left], [right]) => compareStrings(left, right))
            .map(([runId, runTotals]): RunUsage => Object.freeze({ runId, totals: runTotals })),
        ),
        byAgent: Object.freeze(
          [...agents.values()].sort(
            (left, right) =>
              compareStrings(left.runId, right.runId) ||
              compareStrings(left.agentId, right.agentId),
          ),
        ),
        byGoal: Object.freeze(byGoal),
        byModel: Object.freeze(
          [...models.values()].sort(
            (left, right) =>
              compareStrings(left.provider, right.provider) ||
              compareStrings(left.model, right.model),
          ),
        ),
      });
    },
  };
  return ledger;
}

/** Headline efficiency figures for a set of goals. */
export function goalEfficiency(goals: readonly GoalUsage[]): GoalEfficiency {
  const count = (outcome: GoalUsageOutcome) =>
    goals.filter((entry) => entry.outcome === outcome).length;
  const completedGoals = count("completed");
  const goalTokens = goals.reduce((sum, entry) => sum + entry.totals.totalTokens, 0);
  const goalCostUsd = goals.reduce((sum, entry) => sum + entry.totals.costUsd, 0);
  return Object.freeze({
    goalCount: goals.length,
    completedGoals,
    failedGoals: count("failed"),
    cancelledGoals: count("cancelled"),
    openGoals: count("open"),
    goalTokens,
    goalCostUsd,
    tokensPerCompletedGoal: completedGoals === 0 ? null : goalTokens / completedGoals,
    costPerCompletedGoalUsd: completedGoals === 0 ? null : goalCostUsd / completedGoals,
  });
}

/** Summarize a recorded event log (for example a run's stored events). */
export function summarizeUsageEvents(events: Iterable<CanonicalEvent>): UsageSummary {
  const ledger = createUsageLedger();
  for (const event of events) {
    ledger.observe(event);
  }
  return ledger.summary();
}
