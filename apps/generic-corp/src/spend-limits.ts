import type { AgentHold } from "@generic-ai/plugin-delegation";
import {
  type CanonicalEvent,
  type RunStoreContract,
  type StorageContract,
  summarizeUsageEvents,
} from "@generic-ai/sdk";

/**
 * Spending limits (design decision 42): an optional limit for the whole company and an optional
 * limit per agent, each in dollars and/or tokens over a day, week or month (server time). When
 * a limit is reached, the agents it covers are held: nothing new starts and a running turn stops
 * after its current step. Nothing is lost; held work gets a fresh turn when the period rolls over
 * or the owner raises the limit.
 *
 * Usage is counted as it happens, from the `usage.recorded` events every turn writes to the run
 * store, into daily buckets per agent kept in host storage.
 */

export type LimitPeriod = "day" | "week" | "month";
export const LIMIT_PERIODS: readonly LimitPeriod[] = ["day", "week", "month"];

export interface SpendLimit {
  readonly period: LimitPeriod;
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
}

export interface SpendLimitSettings {
  readonly company?: SpendLimit;
  readonly agents: Readonly<Record<string, SpendLimit>>;
  readonly updatedAt?: string;
}

export interface SpendAmount {
  readonly costUsd: number;
  readonly tokens: number;
}

export interface SpendLimitStatus {
  readonly limit: SpendLimit;
  readonly spent: SpendAmount;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reached: boolean;
}

export interface SpendLimitsView {
  readonly company?: SpendLimitStatus;
  readonly agents: Readonly<Record<string, SpendLimitStatus>>;
  /** What each agent has spent today, this week and this month, limit or not. */
  readonly spending: Readonly<
    Record<
      string,
      { readonly day: SpendAmount; readonly week: SpendAmount; readonly month: SpendAmount }
    >
  >;
  readonly updatedAt?: string;
}

export class SpendLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendLimitError";
  }
}

const NAMESPACE = "generic-corp-owner";
const SETTINGS_KEY = { namespace: NAMESPACE, collection: "settings", id: "spending-limits" };
const LEDGER_COLLECTION = "spend-daily";
/** Daily buckets older than this are dropped: no period reaches further back. */
const KEEP_DAYS = 40;
/** Usage recorded without an agent (it still counts toward the company limit). */
const UNATTRIBUTED = "";

// --- Periods (server time) ------------------------------------------------

function dayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The start and end of the period that holds `at`. Weeks start on Monday. */
export function periodBounds(period: LimitPeriod, at: Date): { start: Date; end: Date } {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  if (period === "week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  } else if (period === "month") {
    start.setDate(1);
  }
  const end = new Date(start);
  if (period === "day") {
    end.setDate(end.getDate() + 1);
  } else if (period === "week") {
    end.setDate(end.getDate() + 7);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return { start, end };
}

// --- Parsing --------------------------------------------------------------

/** Reads a limit from the owner's input; `null` or `undefined` clears it. */
export function parseSpendLimit(input: unknown): SpendLimit | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new SpendLimitError(
      'Send a limit like {"period": "day", "maxCostUsd": 20}, or null to remove it.',
    );
  }
  const raw = input as Record<string, unknown>;
  const period = raw["period"] ?? "month";
  if (!LIMIT_PERIODS.includes(period as LimitPeriod)) {
    throw new SpendLimitError(`The period must be one of ${LIMIT_PERIODS.join(", ")}.`);
  }
  const amount = (key: string): number | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new SpendLimitError(`${key} must be a number above 0.`);
    }
    return value;
  };
  const maxCostUsd = amount("maxCostUsd");
  const maxTokens = amount("maxTokens");
  if (maxCostUsd === undefined && maxTokens === undefined) {
    throw new SpendLimitError("A limit needs maxCostUsd, maxTokens or both.");
  }
  return {
    period: period as LimitPeriod,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxTokens === undefined ? {} : { maxTokens: Math.floor(maxTokens) }),
  };
}

function reachedLimit(limit: SpendLimit, spent: SpendAmount): boolean {
  return (
    (limit.maxCostUsd !== undefined && spent.costUsd >= limit.maxCostUsd) ||
    (limit.maxTokens !== undefined && spent.tokens >= limit.maxTokens)
  );
}

const PERIOD_WORDS: Record<LimitPeriod, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

function describeLimit(limit: SpendLimit): string {
  const parts = [
    ...(limit.maxCostUsd === undefined ? [] : [`$${limit.maxCostUsd.toFixed(2)}`]),
    ...(limit.maxTokens === undefined ? [] : [`${limit.maxTokens.toLocaleString("en-US")} tokens`]),
  ];
  return parts.join(" / ");
}

function describeSpent(limit: SpendLimit, spent: SpendAmount): string {
  return [
    ...(limit.maxCostUsd === undefined ? [] : [`$${spent.costUsd.toFixed(2)}`]),
    ...(limit.maxTokens === undefined ? [] : [`${spent.tokens.toLocaleString("en-US")} tokens`]),
  ].join(" / ");
}

// --- The store ------------------------------------------------------------

export interface SpendingLimits {
  settings(): SpendLimitSettings;
  view(): SpendLimitsView;
  setCompanyLimit(limit: SpendLimit | undefined): Promise<SpendLimitsView>;
  setAgentLimit(agentId: string, limit: SpendLimit | undefined): Promise<SpendLimitsView>;
  /** Adds usage for an agent (or the company, with no agent). */
  record(agentId: string | undefined, amount: SpendAmount): void;
  /** What an agent (or, with no agent, the whole company) spent in the period holding now. */
  spent(agentId: string | undefined, period: LimitPeriod): SpendAmount;
  /** The hold source: the reached limit that covers this agent, if any. */
  holdFor(agentId: string): AgentHold | undefined;
  /**
   * Counts usage from turn events as they are written. Turns that run as `agentId` should be
   * registered with `trackRun` so their usage is credited to that agent.
   */
  meter(runStore: RunStoreContract): RunStoreContract;
  trackRun(runId: string, agentId: string): () => void;
  /** Watches for period roll-overs. */
  start(): void;
  /** Stops watching and writes the ledger. */
  stop(): Promise<void>;
  flush(): Promise<void>;
}

export interface OpenSpendingLimitsOptions {
  readonly kv: StorageContract;
  /** Agents limits may name. */
  readonly agentIds: () => readonly string[];
  /** Called when held work may resume: a limit was raised or removed, or a period rolled over. */
  readonly onRelease?: () => unknown;
  readonly now?: () => Date;
  /** How often to check for a new period. Defaults to one minute. */
  readonly checkEveryMs?: number;
}

export async function openSpendingLimits(
  options: OpenSpendingLimitsOptions,
): Promise<SpendingLimits> {
  const { kv } = options;
  const now = options.now ?? (() => new Date());
  let settings: SpendLimitSettings = (await kv.get<SpendLimitSettings>(SETTINGS_KEY))?.value ?? {
    agents: {},
  };

  // day -> agentId -> amount
  const ledger = new Map<string, Map<string, SpendAmount>>();
  const dirty = new Set<string>();
  const oldest = new Date(now());
  oldest.setDate(oldest.getDate() - KEEP_DAYS);
  const oldestKey = dayKey(oldest);
  for (const record of await kv.list({ namespace: NAMESPACE, collection: LEDGER_COLLECTION })) {
    const separator = record.key.id.indexOf(":");
    const day = record.key.id.slice(0, separator);
    const agentId = record.key.id.slice(separator + 1);
    if (day < oldestKey) {
      await kv.delete(record.key);
      continue;
    }
    const value = record.value as Partial<SpendAmount>;
    const byAgent = ledger.get(day) ?? new Map<string, SpendAmount>();
    byAgent.set(agentId, { costUsd: value.costUsd ?? 0, tokens: value.tokens ?? 0 });
    ledger.set(day, byAgent);
  }

  let flushTimer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> = Promise.resolve();
  const flush = async () => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const keys = [...dirty];
    dirty.clear();
    flushing = flushing.then(async () => {
      for (const key of keys) {
        const separator = key.indexOf(":");
        const value = ledger.get(key.slice(0, separator))?.get(key.slice(separator + 1));
        if (value !== undefined) {
          await kv.set({
            key: { namespace: NAMESPACE, collection: LEDGER_COLLECTION, id: key },
            value,
            updatedAt: now().toISOString(),
          });
        }
      }
    });
    await flushing;
  };

  const spentBetween = (agentId: string | undefined, start: Date, end: Date): SpendAmount => {
    let costUsd = 0;
    let tokens = 0;
    const startKey = dayKey(start);
    const endKey = dayKey(end);
    for (const [day, byAgent] of ledger) {
      if (day < startKey || day >= endKey) {
        continue;
      }
      for (const [id, amount] of byAgent) {
        if (agentId === undefined || id === agentId) {
          costUsd += amount.costUsd;
          tokens += amount.tokens;
        }
      }
    }
    return { costUsd, tokens };
  };

  const spent = (agentId: string | undefined, period: LimitPeriod) => {
    const { start, end } = periodBounds(period, now());
    return spentBetween(agentId, start, end);
  };

  const statusOf = (agentId: string | undefined, limit: SpendLimit): SpendLimitStatus => {
    const { start, end } = periodBounds(limit.period, now());
    const amount = spentBetween(agentId, start, end);
    return {
      limit,
      spent: amount,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      reached: reachedLimit(limit, amount),
    };
  };

  const view = (): SpendLimitsView => {
    const agents: Record<string, SpendLimitStatus> = {};
    for (const [agentId, limit] of Object.entries(settings.agents)) {
      agents[agentId] = statusOf(agentId, limit);
    }
    const spending: Record<string, { day: SpendAmount; week: SpendAmount; month: SpendAmount }> =
      {};
    for (const agentId of options.agentIds()) {
      spending[agentId] = {
        day: spent(agentId, "day"),
        week: spent(agentId, "week"),
        month: spent(agentId, "month"),
      };
    }
    return {
      ...(settings.company === undefined ? {} : { company: statusOf(undefined, settings.company) }),
      agents,
      spending,
      ...(settings.updatedAt === undefined ? {} : { updatedAt: settings.updatedAt }),
    };
  };

  const save = async (next: SpendLimitSettings) => {
    settings = { ...next, updatedAt: now().toISOString() };
    await kv.set({ key: SETTINGS_KEY, value: settings, updatedAt: settings.updatedAt as string });
    // A raised or removed limit may free held work; the holds re-check every held task.
    await Promise.resolve(options.onRelease?.()).catch(() => undefined);
    return view();
  };

  const runAgents = new Map<string, string>();
  const credit = async (
    store: RunStoreContract,
    runId: string,
    events: readonly CanonicalEvent[],
  ) => {
    if (!events.some((event) => event.name === "usage.recorded")) {
      return;
    }
    let agentId = runAgents.get(runId);
    if (agentId === undefined) {
      const run = await Promise.resolve(store.getRun(runId)).catch(() => undefined);
      const fromRun = run?.metadata?.["agentId"];
      agentId = typeof fromRun === "string" ? fromRun : undefined;
    }
    const totals = summarizeUsageEvents(events).totals;
    record(agentId, { costUsd: totals.costUsd, tokens: totals.totalTokens });
  };

  function record(agentId: string | undefined, amount: SpendAmount) {
    if (amount.costUsd <= 0 && amount.tokens <= 0) {
      return;
    }
    const day = dayKey(now());
    const id = agentId ?? UNATTRIBUTED;
    const byAgent = ledger.get(day) ?? new Map<string, SpendAmount>();
    const current = byAgent.get(id) ?? { costUsd: 0, tokens: 0 };
    byAgent.set(id, {
      costUsd: current.costUsd + amount.costUsd,
      tokens: current.tokens + amount.tokens,
    });
    ledger.set(day, byAgent);
    dirty.add(`${day}:${id}`);
    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flush().catch(() => undefined);
      }, 2_000);
      flushTimer.unref();
    }
  }

  let watcher: NodeJS.Timeout | undefined;
  let lastDay = dayKey(now());

  return {
    settings: () => settings,
    view,
    async setCompanyLimit(limit) {
      const { company: _old, ...rest } = settings;
      return save(limit === undefined ? rest : { ...rest, company: limit });
    },
    async setAgentLimit(agentId, limit) {
      if (!options.agentIds().includes(agentId)) {
        throw new SpendLimitError(`Agent ${agentId} was not found.`);
      }
      const { [agentId]: _old, ...others } = settings.agents;
      return save({
        ...settings,
        agents: limit === undefined ? others : { ...others, [agentId]: limit },
      });
    },
    record,
    spent,
    holdFor(agentId) {
      const checks: Array<[AgentHold["kind"], string | undefined, SpendLimit | undefined, string]> =
        [
          ["company-limit", undefined, settings.company, "The company's"],
          ["agent-limit", agentId, settings.agents[agentId], "This agent's"],
        ];
      for (const [kind, scope, limit, whose] of checks) {
        if (limit === undefined) {
          continue;
        }
        const status = statusOf(scope, limit);
        if (status.reached) {
          return {
            kind,
            reason: `Paused. ${whose} ${PERIOD_WORDS[limit.period]} spending limit of ${describeLimit(limit)} is reached (${describeSpent(limit, status.spent)} spent). Work resumes when the period ends or you raise the limit.`,
            until: status.periodEnd,
          };
        }
      }
      return undefined;
    },
    meter(runStore) {
      return new Proxy(runStore, {
        get(target, property, receiver) {
          if (property === "appendEvents") {
            return async (runId: string, events: readonly CanonicalEvent[]) => {
              if (!events.some((event) => event.name === "usage.recorded")) {
                return target.appendEvents(runId, events);
              }
              // Appends are idempotent: a resumed turn may write events again. Only events
              // past the run's last sequence before this append are new spending.
              const before = await target.lastSequence(runId);
              const result = await target.appendEvents(runId, events);
              if (result.appended > 0) {
                await credit(
                  target,
                  runId,
                  events.filter((event) => event.sequence > before),
                ).catch(() => undefined);
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    trackRun(runId, agentId) {
      runAgents.set(runId, agentId);
      return () => {
        runAgents.delete(runId);
      };
    },
    start() {
      if (watcher !== undefined) {
        return;
      }
      watcher = setInterval(() => {
        const today = dayKey(now());
        if (today !== lastDay) {
          // A new day may start a new week or month too: held work gets another look.
          lastDay = today;
          void Promise.resolve(options.onRelease?.()).catch(() => undefined);
        }
      }, options.checkEveryMs ?? 60_000);
      watcher.unref();
    },
    async stop() {
      if (watcher !== undefined) {
        clearInterval(watcher);
        watcher = undefined;
      }
      await flush();
    },
    flush,
  };
}
