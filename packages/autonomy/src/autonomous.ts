// Autonomous mode: runtime state, limits, status and continuation texts. Adapted from Prime Agent's
// `autonomous/mod.rs` (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { Usage } from "@generic-ai/ai";

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
  "No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.";

export const DEFAULT_MAX_CONTINUATIONS = 3;
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOKENS = 80_000;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_GATE_MAX_RETRIES = 3;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const UNLIMITED_AUTONOMOUS_LIMIT = Number.MAX_SAFE_INTEGER;

export interface AutonomousGateConfig {
  /** Shell commands that must all exit 0 before the run may stop. */
  readonly commands?: readonly string[] | undefined;
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AutonomousConfig {
  readonly enabled?: boolean | undefined;
  readonly maxContinuations?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly continuationPrompt?: string | undefined;
  readonly gates?: AutonomousGateConfig | undefined;
}

export interface AutonomousLimits {
  readonly maxContinuations: number;
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface NormalizedGateConfig {
  readonly commands: readonly string[];
  readonly maxRetries: number;
  readonly timeoutMs: number;
}

export interface AutonomousGateFailure {
  readonly command: string;
  readonly attempt: number;
  readonly exitText: string;
  readonly output: string;
}

/** A fingerprint of the working tree, so a failed gate is not rerun on unchanged files. */
export interface WorktreeSnapshot {
  readonly status: string;
  readonly diff: string;
  readonly untrackedHash: string;
}

export interface AutonomousRuntimeState {
  enabled: boolean;
  continuationsUsed: number;
  turnsUsed: number;
  tokensUsed: number;
  startedAt: number | undefined;
  limits: AutonomousLimits;
  continuationPrompt: string;
  gates: NormalizedGateConfig;
  gateAttempts: Map<string, number>;
  lastGateFailure: AutonomousGateFailure | undefined;
  lastGateFailureSnapshot: WorktreeSnapshot | undefined;
}

export interface AutonomousStatus {
  readonly enabled: boolean;
  readonly continuationsUsed: number;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly startedAt?: number;
  readonly limits: AutonomousLimits;
  readonly gates: NormalizedGateConfig;
  readonly gateAttempts: Readonly<Record<string, number>>;
  readonly lastGateFailure?: AutonomousGateFailure;
}

export type AutonomousLimitReason = "maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs";

export function isUnlimitedAutonomousLimit(value: number): boolean {
  return value >= UNLIMITED_AUTONOMOUS_LIMIT;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

export function createAutonomousRuntimeState(
  config?: AutonomousConfig,
  defaults: AutonomousConfig = {},
  now: number = Date.now(),
): AutonomousRuntimeState {
  const enabled = config?.enabled === true;
  const prompt = config?.continuationPrompt?.trim();
  return {
    enabled,
    continuationsUsed: 0,
    turnsUsed: 0,
    tokensUsed: 0,
    startedAt: enabled ? now : undefined,
    limits: {
      maxContinuations: normalizeLimit(
        config?.maxContinuations,
        normalizeLimit(defaults.maxContinuations, DEFAULT_MAX_CONTINUATIONS),
      ),
      maxTurns: normalizeLimit(
        config?.maxTurns,
        normalizeLimit(defaults.maxTurns, DEFAULT_MAX_TURNS),
      ),
      maxTokens: normalizeLimit(
        config?.maxTokens,
        normalizeLimit(defaults.maxTokens, DEFAULT_MAX_TOKENS),
      ),
      timeoutMs: normalizeLimit(
        config?.timeoutMs,
        normalizeLimit(defaults.timeoutMs, DEFAULT_TIMEOUT_MS),
      ),
    },
    continuationPrompt:
      prompt === undefined || prompt.length === 0 ? DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT : prompt,
    gates: {
      commands: [...(config?.gates?.commands ?? [])],
      maxRetries: normalizeLimit(config?.gates?.maxRetries, DEFAULT_GATE_MAX_RETRIES),
      timeoutMs: normalizeLimit(config?.gates?.timeoutMs, DEFAULT_GATE_TIMEOUT_MS),
    },
    gateAttempts: new Map(),
    lastGateFailure: undefined,
    lastGateFailureSnapshot: undefined,
  };
}

/** Turn autonomous mode on or off. Turning it on resets the counters and the clock. */
export function setAutonomousEnabled(
  state: AutonomousRuntimeState,
  enabled: boolean,
  now: number = Date.now(),
): void {
  state.enabled = enabled;
  state.gateAttempts.clear();
  state.lastGateFailure = undefined;
  state.lastGateFailureSnapshot = undefined;
  if (enabled) {
    state.continuationsUsed = 0;
    state.turnsUsed = 0;
    state.tokensUsed = 0;
    state.startedAt = now;
  } else {
    state.startedAt = undefined;
  }
}

/** Change limits, prompt or gates; fields left out keep their values. */
export function setAutonomousLimits(state: AutonomousRuntimeState, config: AutonomousConfig): void {
  state.limits = {
    maxContinuations: normalizeLimit(config.maxContinuations, state.limits.maxContinuations),
    maxTurns: normalizeLimit(config.maxTurns, state.limits.maxTurns),
    maxTokens: normalizeLimit(config.maxTokens, state.limits.maxTokens),
    timeoutMs: normalizeLimit(config.timeoutMs, state.limits.timeoutMs),
  };
  const prompt = config.continuationPrompt?.trim();
  if (prompt !== undefined && prompt.length > 0) {
    state.continuationPrompt = prompt;
  }
  if (config.gates !== undefined) {
    state.gates = {
      commands:
        config.gates.commands === undefined ? state.gates.commands : [...config.gates.commands],
      maxRetries: normalizeLimit(config.gates.maxRetries, state.gates.maxRetries),
      timeoutMs: normalizeLimit(config.gates.timeoutMs, state.gates.timeoutMs),
    };
  }
}

export function autonomousStatus(state: AutonomousRuntimeState): AutonomousStatus {
  return {
    enabled: state.enabled,
    continuationsUsed: state.continuationsUsed,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    limits: state.limits,
    gates: state.gates,
    gateAttempts: Object.fromEntries(state.gateAttempts),
    ...(state.lastGateFailure === undefined ? {} : { lastGateFailure: state.lastGateFailure }),
  };
}

/** Tokens one turn spends against the autonomous limit: input, output and cache writes. */
export function autonomousTokenDelta(
  usage: Pick<Usage, "input" | "output" | "cacheWrite"> | undefined,
): number {
  return usage === undefined ? 0 : usage.input + usage.output + usage.cacheWrite;
}

export function addAutonomousUsage(
  state: AutonomousRuntimeState,
  usage: Pick<Usage, "input" | "output" | "cacheWrite"> | undefined,
): void {
  if (!state.enabled) {
    return;
  }
  state.turnsUsed += 1;
  state.tokensUsed += autonomousTokenDelta(usage);
}

export function addAutonomousContinuation(state: AutonomousRuntimeState): void {
  if (state.enabled) {
    state.continuationsUsed += 1;
  }
}

export function autonomousLimitReason(
  state: Pick<
    AutonomousRuntimeState,
    "continuationsUsed" | "turnsUsed" | "tokensUsed" | "startedAt" | "limits"
  >,
  now: number = Date.now(),
): AutonomousLimitReason | undefined {
  if (state.continuationsUsed >= state.limits.maxContinuations) {
    return "maxContinuations";
  }
  if (state.turnsUsed >= state.limits.maxTurns) {
    return "maxTurns";
  }
  if (state.tokensUsed >= state.limits.maxTokens) {
    return "maxTokens";
  }
  if (
    state.startedAt !== undefined &&
    Math.max(0, now - state.startedAt) >= state.limits.timeoutMs
  ) {
    return "timeoutMs";
  }
  return undefined;
}

export function describeAutonomousLimit(
  status: AutonomousStatus,
  reason: AutonomousLimitReason,
  now: number = Date.now(),
): string {
  switch (reason) {
    case "maxContinuations":
      return `maxContinuations reached (${status.continuationsUsed}/${status.limits.maxContinuations})`;
    case "maxTurns":
      return `maxTurns reached (${status.turnsUsed}/${status.limits.maxTurns})`;
    case "maxTokens":
      return `maxTokens reached (${status.tokensUsed}/${status.limits.maxTokens})`;
    case "timeoutMs": {
      const elapsed = status.startedAt === undefined ? 0 : Math.max(0, now - status.startedAt);
      return `timeoutMs reached (${elapsed}/${status.limits.timeoutMs})`;
    }
  }
}

export function autonomousContinuationText(state: AutonomousRuntimeState): string {
  return `[autonomous-continuation]\n\n${state.continuationPrompt}`;
}

export function buildAutonomousGateFailureContinuation(
  failure: AutonomousGateFailure,
  maxRetries: number,
  timestamp: number,
): string {
  const output = failure.output.length === 0 ? "" : `\nOutput:\n${failure.output}\n`;
  return `[autonomous-continuation: gate-failed]\n\nAutonomous quality gate failed (attempt ${failure.attempt}/${maxRetries}): \`${failure.command}\` ${failure.exitText}.\n${output}\n\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: ${new Date(timestamp).toISOString()}.`;
}

export function latestAutonomousGateAttempt(status: AutonomousStatus): number {
  return Math.max(status.lastGateFailure?.attempt ?? 0, ...Object.values(status.gateAttempts), 0);
}
