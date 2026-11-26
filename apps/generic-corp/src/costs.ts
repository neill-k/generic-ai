import type { RunRecord, RunStoreContract, UsageTotals } from "@generic-ai/sdk";
import { summarizeUsageEvents } from "@generic-ai/sdk";

/**
 * Cost rollups for the dashboard, read from the usage events (ADR 0053) in
 * the persisted harness runs of every agent turn.
 */
export interface CostRollup {
  readonly key: string;
  readonly totals: UsageTotals;
}

export interface CompanyCosts {
  readonly totals: UsageTotals;
  readonly byAgent: readonly CostRollup[];
  readonly byModel: readonly CostRollup[];
  /** Per owner request (root task). */
  readonly byRequest: readonly CostRollup[];
  /** Owner requests that finished successfully, and what each cost on average. */
  readonly completedRequests: number;
  readonly tokensPerCompletedRequest: number | null;
  readonly costPerCompletedRequestUsd: number | null;
  /** Harness runs read. Older runs past `limit` are not counted. */
  readonly runsCounted: number;
}

export const HARNESS_RUN_KIND = "agent-harness-run";

export function emptyTotals(): UsageTotals {
  return {
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    responses: a.responses + b.responses,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function bump(map: Map<string, UsageTotals>, key: string, totals: UsageTotals): void {
  map.set(key, addTotals(map.get(key) ?? emptyTotals(), totals));
}

function sorted(map: Map<string, UsageTotals>): CostRollup[] {
  return [...map.entries()]
    .map(([key, totals]) => ({ key, totals }))
    .sort(
      (a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens,
    );
}

function stringField(record: RunRecord, ...path: string[]): string | undefined {
  let value: unknown = record.metadata;
  for (const key of path) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

export async function summarizeCompanyCosts(
  runStore: RunStoreContract,
  options: {
    readonly limit?: number;
    /** Root task ids of owner requests that succeeded. */
    readonly completedRequestIds?: ReadonlySet<string>;
    /** Only count runs for this agent. */
    readonly agentId?: string;
  } = {},
): Promise<CompanyCosts> {
  const runs = (await runStore.listRuns({ limit: options.limit ?? 1000 })).filter(
    (record) => record.metadata?.["kind"] === HARNESS_RUN_KIND,
  );
  let totals = emptyTotals();
  const byAgent = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byRequest = new Map<string, UsageTotals>();
  let counted = 0;

  for (const run of runs) {
    const agentId = stringField(run, "agentId") ?? "unknown";
    if (options.agentId !== undefined && agentId !== options.agentId) {
      continue;
    }
    counted += 1;
    const summary = summarizeUsageEvents(await runStore.readEvents(run.envelope.runId));
    if (summary.totals.responses === 0) {
      continue;
    }
    totals = addTotals(totals, summary.totals);
    bump(byAgent, agentId, summary.totals);
    const rootTaskId = stringField(run, "input", "rootTaskId");
    if (rootTaskId !== undefined) {
      bump(byRequest, rootTaskId, summary.totals);
    }
    for (const model of summary.byModel) {
      bump(byModel, `${model.provider}/${model.model}`, model.totals);
    }
  }

  const completed = options.completedRequestIds ?? new Set<string>();
  let requestTokens = 0;
  let requestCost = 0;
  for (const [, value] of byRequest) {
    requestTokens += value.totalTokens;
    requestCost += value.costUsd;
  }
  return {
    totals,
    byAgent: sorted(byAgent),
    byModel: sorted(byModel),
    byRequest: sorted(byRequest),
    completedRequests: completed.size,
    // Like tokens per completed goal (ADR 0053): failed and open requests are charged too.
    tokensPerCompletedRequest: completed.size === 0 ? null : requestTokens / completed.size,
    costPerCompletedRequestUsd: completed.size === 0 ? null : requestCost / completed.size,
    runsCounted: counted,
  };
}
