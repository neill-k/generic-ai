// Autonomous quality gates and the follow-up decision after each turn. Adapted from Prime Agent's
// `autonomous/gates.rs` and `autonomous/driver.rs` (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AssistantMessage } from "@generic-ai/ai";

import {
  type AutonomousLimitReason,
  type AutonomousRuntimeState,
  type AutonomousStatus,
  addAutonomousContinuation,
  addAutonomousUsage,
  autonomousContinuationText,
  autonomousLimitReason,
  autonomousStatus,
  buildAutonomousGateFailureContinuation,
  type WorktreeSnapshot,
} from "./autonomous.js";

export const MAX_GATE_OUTPUT_CHARS = 6000;

export interface GateCommandResult {
  /** Exit code, or undefined when a signal killed the process. */
  readonly status: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string | undefined;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

/** Runs gate commands and fingerprints the workspace. */
export interface GateRunner {
  runGate(command: string, timeoutMs: number): Promise<GateCommandResult>;
  captureSnapshot?(): Promise<WorktreeSnapshot | undefined>;
}

export type AutonomousGateResult = "passed" | "failed" | "retry-exhausted";

export type AutonomousDecisionReason =
  | "missing-terminal-evidence"
  | "gate-failed"
  | "not-needed"
  | "limit-reached";

export interface AutonomousDecision {
  readonly shouldContinue: boolean;
  readonly reason: AutonomousDecisionReason;
}

export type AutonomousStopReason =
  | { readonly kind: "gate-passed" }
  | { readonly kind: "gate-retry-exhausted" }
  | { readonly kind: "limit"; readonly limit: AutonomousLimitReason };

export type AutonomousFollowUp =
  | { readonly kind: "inactive" }
  | { readonly kind: "continue"; readonly text: string }
  | {
      readonly kind: "stop";
      readonly reason: AutonomousStopReason;
      readonly status: AutonomousStatus;
    };

/**
 * Decide whether autonomous mode continues after a turn. Gates that pass stop the run; a failed
 * gate continues it with the failure until the retries or a limit run out; with no gates the run
 * continues until a limit is reached.
 */
export async function shouldAutonomouslyContinue(
  state: AutonomousRuntimeState,
  stopReason: AssistantMessage["stopReason"] | undefined,
  gates: GateRunner,
  now: () => number = Date.now,
): Promise<AutonomousDecision> {
  if (!state.enabled || stopReason === "error" || stopReason === "aborted") {
    return { shouldContinue: false, reason: "not-needed" };
  }
  const gateResult =
    state.gates.commands.length === 0 ? undefined : await runAutonomousQualityGates(state, gates);
  const limit = autonomousLimitReason(state, now());
  switch (gateResult) {
    case "passed":
      return { shouldContinue: false, reason: "not-needed" };
    case "retry-exhausted":
      return { shouldContinue: false, reason: "limit-reached" };
    case "failed":
      return limit === undefined
        ? { shouldContinue: true, reason: "gate-failed" }
        : { shouldContinue: false, reason: "limit-reached" };
    case undefined:
      return limit === undefined
        ? { shouldContinue: true, reason: "missing-terminal-evidence" }
        : { shouldContinue: false, reason: "limit-reached" };
  }
}

async function runAutonomousQualityGates(
  state: AutonomousRuntimeState,
  gates: GateRunner,
): Promise<AutonomousGateResult> {
  const { commands, maxRetries, timeoutMs } = state.gates;
  for (const command of commands) {
    const current = await gates.captureSnapshot?.();
    const sameFailure =
      state.lastGateFailure?.command === command &&
      state.lastGateFailureSnapshot !== undefined &&
      snapshotsEqual(current, state.lastGateFailureSnapshot);
    if (sameFailure && state.lastGateFailure !== undefined) {
      const attempt = (state.gateAttempts.get(command) ?? state.lastGateFailure.attempt) + 1;
      state.gateAttempts.set(command, attempt);
      state.lastGateFailure = {
        ...state.lastGateFailure,
        attempt,
        exitText: "not rerun: workspace unchanged since previous failed gate",
        output:
          "The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.",
      };
      return gateAttemptResult(attempt, maxRetries);
    }
    let result: GateCommandResult;
    try {
      result = await gates.runGate(command, timeoutMs);
    } catch {
      const attempt = (state.gateAttempts.get(command) ?? 0) + 1;
      state.gateAttempts.set(command, attempt);
      state.lastGateFailure = { command, attempt, exitText: "failed to run", output: "" };
      state.lastGateFailureSnapshot = undefined;
      return gateAttemptResult(attempt, maxRetries);
    }
    if (result.status === 0 && result.error === undefined && !result.timedOut) {
      state.gateAttempts.set(command, 0);
      if (state.lastGateFailure?.command === command) {
        state.lastGateFailure = undefined;
        state.lastGateFailureSnapshot = undefined;
      }
      continue;
    }
    const attempt = (state.gateAttempts.get(command) ?? 0) + 1;
    state.gateAttempts.set(command, attempt);
    const output = [result.stdout, result.stderr]
      .filter((text) => text.length > 0)
      .join("\n")
      .trim();
    state.lastGateFailure = {
      command,
      attempt,
      exitText: formatProcessExit(result),
      output: truncateGateOutput(output, result.outputTruncated),
    };
    state.lastGateFailureSnapshot = await gates.captureSnapshot?.();
    return gateAttemptResult(attempt, maxRetries);
  }
  state.lastGateFailure = undefined;
  state.lastGateFailureSnapshot = undefined;
  return "passed";
}

function gateAttemptResult(attempt: number, maxRetries: number): AutonomousGateResult {
  return attempt > maxRetries ? "retry-exhausted" : "failed";
}

export function snapshotsEqual(
  a: WorktreeSnapshot | undefined,
  b: WorktreeSnapshot | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.status === b.status &&
    a.diff === b.diff &&
    a.untrackedHash === b.untrackedHash
  );
}

export function formatProcessExit(result: GateCommandResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  if (result.error !== undefined) {
    return result.error;
  }
  return result.status === undefined ? "killed by signal" : `exited with code ${result.status}`;
}

export function truncateGateOutput(output: string, wasTruncated: boolean): string {
  const chars = [...output];
  if (chars.length <= MAX_GATE_OUTPUT_CHARS && !wasTruncated) {
    return output;
  }
  return `${chars.slice(0, MAX_GATE_OUTPUT_CHARS).join("")}\n... [truncated]`;
}

/** Drives autonomous mode across turns: accounts each turn and decides what follows it. */
export class AutonomousDriver {
  readonly state: AutonomousRuntimeState;
  readonly #gates: GateRunner;
  readonly #now: () => number;

  constructor(state: AutonomousRuntimeState, gates: GateRunner, now: () => number = Date.now) {
    this.state = state;
    this.#gates = gates;
    this.#now = now;
  }

  /** Count a finished assistant message toward the turn and token limits. Failed turns do not count. */
  accountMessage(message: AssistantMessage): void {
    if (message.stopReason !== "error") {
      addAutonomousUsage(this.state, message.usage);
    }
  }

  async afterTurn(message: AssistantMessage): Promise<AutonomousFollowUp> {
    if (!this.state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
      return { kind: "inactive" };
    }
    const decision = await shouldAutonomouslyContinue(
      this.state,
      message.stopReason,
      this.#gates,
      this.#now,
    );
    if (decision.shouldContinue) {
      addAutonomousContinuation(this.state);
      const failure = this.state.lastGateFailure;
      const text =
        decision.reason === "gate-failed" && failure !== undefined
          ? buildAutonomousGateFailureContinuation(
              failure,
              this.state.gates.maxRetries,
              this.#now(),
            )
          : autonomousContinuationText(this.state);
      return { kind: "continue", text };
    }
    if (decision.reason === "not-needed") {
      return {
        kind: "stop",
        reason: { kind: "gate-passed" },
        status: autonomousStatus(this.state),
      };
    }
    const limit = autonomousLimitReason(this.state, this.#now());
    return {
      kind: "stop",
      reason: limit === undefined ? { kind: "gate-retry-exhausted" } : { kind: "limit", limit },
      status: autonomousStatus(this.state),
    };
  }
}
