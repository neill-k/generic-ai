/** Server shapes for limits, the quality dial, the plan limit and backups. */

export type LimitPeriod = "day" | "week" | "month";

export interface SpendLimit {
  period: LimitPeriod;
  maxCostUsd?: number;
  maxTokens?: number;
}

export interface SpendAmount {
  costUsd: number;
  tokens: number;
}

export interface SpendLimitStatus {
  limit: SpendLimit;
  spent: SpendAmount;
  periodStart: string;
  periodEnd: string;
  reached: boolean;
}

export interface LimitsView {
  company?: SpendLimitStatus;
  agents: Record<string, SpendLimitStatus>;
  spending: Record<string, { day: SpendAmount; week: SpendAmount; month: SpendAmount }>;
  updatedAt?: string;
}

export type QualityLevel = "best" | "balanced" | "cheap";

export interface AgentQuality {
  agentId: string;
  level?: QualityLevel;
  model: string;
  defaultModel: string;
  defaultLevel?: QualityLevel;
  updatedAt?: string;
}

export interface QualityView {
  levels: { level: QualityLevel; model: string }[];
  agents: AgentQuality[];
}

export type PlanLimitBehaviour = "wait" | "api_key";

export interface PlanWindowUsage {
  window: string;
  status: string;
  utilization?: number;
  resetsAt?: string;
  seenAt: string;
}

export interface PlanLimitStatus {
  behaviour: PlanLimitBehaviour;
  limited: boolean;
  limitedUntil?: string;
  resetKnown?: boolean;
  detectedAt?: string;
  apiKeyAvailable: boolean;
  usingApiKey: boolean;
  usage?: PlanWindowUsage[];
}

export type BackupReason = "nightly" | "first" | "manual" | "before-restore";

export interface BackupSummary {
  id: string;
  createdAt: string;
  reason: BackupReason;
  bytes: number;
  durationMs: number;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string;
  keep: number;
  hour: number;
  running: boolean;
  nextAt?: string;
  lastError?: { at: string; message: string };
  backups: BackupSummary[];
}

export const PERIOD_WORD: Record<LimitPeriod, string> = {
  day: "day",
  week: "week",
  month: "month",
};

export const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);
