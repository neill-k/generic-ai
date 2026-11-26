// The thread-goal driver: start, pause, resume, complete, budget accounting, and continuation with
// a no-progress cap and backoff. Adapted from Prime Agent's `session_engine/goal_driver.rs` and
// `goal_driver/progress.rs` (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";

import type { AssistantMessage, Usage } from "@generic-ai/ai";

import {
  createGoalContextText,
  emptyGoalState,
  type GoalState,
  goalTokenDeltaForUsage,
  normalizeGoalState,
  validateGoalBudget,
  validateGoalObjective,
} from "./goals.js";

/** Consecutive turns without output after which the goal stops with an error. */
export const CONTINUATION_NO_PROGRESS_CAP = 3;
/** First backoff after a turn without output; it doubles with each further one. */
export const CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS = 10_000;
export const CONTINUATION_NO_PROGRESS_CAP_REASON =
  "Goal continuation cap reached: consecutive turns made no progress";

export type UsageOutcome = "accounted" | "budget-reached" | "ignored";

export interface GoalDriverOptions {
  /** Called with every new goal state, so a host can persist it. */
  readonly persist?: ((state: GoalState) => void) | undefined;
  readonly now?: (() => number) | undefined;
  /** Whether a failed turn hit a rate limit, which parks the goal instead of failing it. */
  readonly isRateLimit?: ((message: AssistantMessage) => boolean) | undefined;
}

export function creationElapsedSeconds(createdAt: number | undefined, now: number): number {
  return createdAt === undefined ? 0 : Math.floor(Math.max(0, now - createdAt) / 1000);
}

/** True when a turn produced no text, no thinking and no tool call. */
export function turnProducedNoOutput(message: AssistantMessage): boolean {
  return message.content.every((part) => {
    if (part.type === "text") {
      return part.text.length === 0;
    }
    if (part.type === "thinking") {
      return part.thinking.length === 0;
    }
    return false;
  });
}

function defaultIsRateLimit(message: AssistantMessage): boolean {
  return /rate.?limit|\b429\b|too many requests/i.test(message.errorMessage ?? "");
}

export class GoalDriver {
  #state: GoalState = emptyGoalState();
  readonly #accountedMessages = new Set<string>();
  #pendingContinuation = false;
  #noProgressStreak = 0;
  #noProgressBackoffUntilMs = 0;
  #parkedRefusalUntilMs = 0;
  #countedNoProgressTurnMs: number | undefined;
  #billedTokens = 0;
  readonly #persist: ((state: GoalState) => void) | undefined;
  readonly #now: () => number;
  readonly #isRateLimit: (message: AssistantMessage) => boolean;

  constructor(options: GoalDriverOptions = {}) {
    this.#persist = options.persist;
    this.#now = options.now ?? Date.now;
    this.#isRateLimit = options.isRateLimit ?? defaultIsRateLimit;
  }

  /** A driver restored from a persisted state. An active goal whose last turn failed is an error. */
  static restore(
    state: GoalState,
    options: GoalDriverOptions & { readonly lastTurn?: AssistantMessage | undefined } = {},
  ): GoalDriver {
    const driver = new GoalDriver(options);
    let restored = state;
    if (restored.status === "active" && options.lastTurn !== undefined) {
      const error = driver.terminalProviderFailure(options.lastTurn);
      if (error !== undefined) {
        restored = {
          ...restored,
          active: false,
          status: "error",
          lastReason: error,
          lastError: error,
        };
      }
    }
    driver.#state = normalizeGoalState(restored);
    driver.#noProgressStreak = driver.#state.noProgressStreak ?? 0;
    driver.#countedNoProgressTurnMs = driver.#state.noProgressTurnMs;
    return driver;
  }

  get state(): GoalState {
    return this.#state;
  }

  /** The state with `timeUsedSeconds` read fresh from the creation time. */
  stateWithCreationElapsed(): GoalState {
    return this.#state.createdAt === undefined
      ? this.#state
      : {
          ...this.#state,
          timeUsedSeconds: creationElapsedSeconds(this.#state.createdAt, this.#now()),
        };
  }

  get noProgressStreak(): number {
    return this.#noProgressStreak;
  }

  get pendingContinuation(): boolean {
    return this.#pendingContinuation;
  }

  get activeObjective(): string | undefined {
    return this.#state.status === "active" ? this.#state.objective : undefined;
  }

  /**
   * Start a new active goal, replacing whatever was there. `goalId` ties it to a goal defined
   * elsewhere (for example an SDK goal spec); a random id is used otherwise.
   */
  start(objectiveText: string, tokenBudget?: number, goalId?: string): GoalState {
    const objective = validateGoalObjective(objectiveText);
    const budget = validateGoalBudget(tokenBudget);
    const now = this.#now();
    this.#accountedMessages.clear();
    this.#noProgressStreak = 0;
    this.#noProgressBackoffUntilMs = 0;
    this.#parkedRefusalUntilMs = 0;
    this.#countedNoProgressTurnMs = undefined;
    this.#pendingContinuation = false;
    this.#setState({
      active: true,
      status: "active",
      goalId: goalId ?? randomUUID(),
      objective,
      ...(budget === undefined ? {} : { tokenBudget: budget }),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationsUsed: 0,
      createdAt: now,
      noProgressStreak: 0,
    });
    this.#billedTokens = 0;
    return this.stateWithCreationElapsed();
  }

  clear(): void {
    this.#setState(emptyGoalState());
    this.#pendingContinuation = false;
  }

  /**
   * Add spend that is not an assistant message of this session (a subagent's or a tool's own model
   * call). It is charged with the next accounted message or on pause.
   */
  recordBilledUsage(usage: Pick<Usage, "input" | "output">): void {
    this.#billedTokens += goalTokenDeltaForUsage(usage.input, usage.output);
  }

  /** Charge one assistant message to the goal once. Reaching the budget marks it budget_limited. */
  recordAssistantUsage(messageId: string, usage: Pick<Usage, "input" | "output">): UsageOutcome {
    if (this.#state.status !== "active") {
      this.#billedTokens = 0;
      return "ignored";
    }
    if (this.#accountedMessages.has(messageId)) {
      return "ignored";
    }
    const billed = this.#billedTokens;
    this.#billedTokens = 0;
    const next: GoalState = {
      ...this.#state,
      tokensUsed:
        this.#state.tokensUsed + goalTokenDeltaForUsage(usage.input, usage.output) + billed,
    };
    const budgetReached = next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget;
    if (budgetReached) {
      this.#setState({
        ...next,
        active: false,
        status: "budget_limited",
        lastReason: `Reached ${next.tokenBudget} token goal budget`,
        lastError: undefined,
      });
    } else {
      this.#setState(next);
    }
    this.#accountedMessages.add(messageId);
    return budgetReached ? "budget-reached" : "accounted";
  }

  pause(reason: string): void {
    if (this.#state.status !== "active") {
      return;
    }
    const billed = this.#billedTokens;
    this.#billedTokens = 0;
    this.#setState({
      ...this.#state,
      active: false,
      status: "paused",
      tokensUsed: this.#state.tokensUsed + billed,
      lastReason: reason,
      lastError: undefined,
    });
    this.#pendingContinuation = false;
  }

  /** Resume a paused or budget-limited goal. Returns the continuation text when it is active again. */
  resume(): string | undefined {
    if (this.#state.objective === undefined) {
      return undefined;
    }
    if (this.#state.status !== "paused" && this.#state.status !== "budget_limited") {
      return undefined;
    }
    const exhausted =
      this.#state.tokenBudget !== undefined && this.#state.tokensUsed >= this.#state.tokenBudget;
    const status = exhausted ? "budget_limited" : "active";
    this.#setState({
      ...this.#state,
      active: status === "active",
      status,
      lastReason: exhausted ? "Goal token budget already reached" : undefined,
      lastError: undefined,
    });
    if (status !== "active") {
      return undefined;
    }
    this.#billedTokens = 0;
    return createGoalContextText(this.#state, "continuation");
  }

  complete(): void {
    if (this.#state.objective === undefined || this.#state.status === "idle") {
      return;
    }
    this.#setState({
      ...this.#state,
      active: false,
      status: "complete",
      lastReason: "Goal achieved",
      lastError: undefined,
    });
  }

  /** An error turn ends an active goal with status error. Other stop reasons leave it as it is. */
  finishForTerminalMessage(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
  ): void {
    if (this.#state.status !== "active" || stopReason !== "error") {
      return;
    }
    const reason =
      errorMessage === undefined || errorMessage.length === 0
        ? "Assistant response failed"
        : errorMessage;
    this.#setState({
      ...this.#state,
      active: false,
      status: "error",
      lastReason: reason,
      lastError: reason,
    });
  }

  /** The error that ends the goal, for a failed turn that is not a rate limit. */
  terminalProviderFailure(message: AssistantMessage): string | undefined {
    if (message.stopReason !== "error" || this.#isRateLimit(message)) {
      return undefined;
    }
    return message.errorMessage === undefined || message.errorMessage.length === 0
      ? "Assistant response failed"
      : message.errorMessage;
  }

  /**
   * The continuation prompt for the next turn of an active goal, or undefined when the goal should
   * not continue now: it is not active, the last turn failed or made no progress, a backoff is
   * running, or a continuation is already pending.
   */
  nextContinuation(lastTurn?: AssistantMessage): string | undefined {
    if (this.#state.status !== "active" || this.#state.objective === undefined) {
      return undefined;
    }
    if (lastTurn !== undefined && !this.#progressGate(lastTurn)) {
      return undefined;
    }
    if (this.#noProgressStreak >= CONTINUATION_NO_PROGRESS_CAP) {
      this.#failNoProgress();
      return undefined;
    }
    const now = this.#now();
    if (now < this.#noProgressBackoffUntilMs || now < this.#parkedRefusalUntilMs) {
      return undefined;
    }
    if (this.#pendingContinuation) {
      return undefined;
    }
    this.#setState({
      ...this.#state,
      continuationsUsed: this.#state.continuationsUsed + 1,
      lastReason: undefined,
      lastError: undefined,
    });
    this.#pendingContinuation = true;
    return createGoalContextText(this.#state, "continuation");
  }

  /** The pending continuation was delivered to the agent. */
  continuationConsumed(): void {
    this.#pendingContinuation = false;
  }

  /** Undo the count of a continuation that was never delivered. */
  rollbackContinuationMint(): void {
    if (this.#state.continuationsUsed > 0) {
      this.#setState({ ...this.#state, continuationsUsed: this.#state.continuationsUsed - 1 });
    }
    this.#pendingContinuation = false;
  }

  /** When a no-progress backoff ends, if one is running for an active goal. */
  backoffWakeAt(): number | undefined {
    const until = Math.max(this.#noProgressBackoffUntilMs, this.#parkedRefusalUntilMs);
    return this.#state.status === "active" && until > this.#now() ? until : undefined;
  }

  #progressGate(turn: AssistantMessage): boolean {
    const turnIsThisGoals =
      this.#state.createdAt === undefined || turn.timestamp > this.#state.createdAt;
    const turnIsNew =
      this.#countedNoProgressTurnMs === undefined || turn.timestamp > this.#countedNoProgressTurnMs;
    if (turnIsThisGoals) {
      const error = this.terminalProviderFailure(turn);
      if (error !== undefined) {
        this.finishForTerminalMessage("error", error);
        return false;
      }
    }
    if (!turnIsThisGoals || !turnIsNew) {
      return true;
    }
    if (turn.stopReason === "error" && this.#isRateLimit(turn)) {
      this.#countedNoProgressTurnMs = turn.timestamp;
      this.#noProgressBackoffUntilMs = 0;
      this.#parkedRefusalUntilMs = this.#now() + CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS;
      return false;
    }
    if (turnProducedNoOutput(turn)) {
      this.#countedNoProgressTurnMs = turn.timestamp;
      this.#noProgressStreak += 1;
      this.#noProgressBackoffUntilMs =
        this.#now() + CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS * 2 ** (this.#noProgressStreak - 1);
      this.#setState({
        ...this.#state,
        noProgressStreak: this.#noProgressStreak,
        noProgressTurnMs: turn.timestamp,
      });
      if (this.#noProgressStreak >= CONTINUATION_NO_PROGRESS_CAP) {
        this.#failNoProgress();
      }
      return false;
    }
    if (this.#noProgressStreak !== 0) {
      this.#noProgressStreak = 0;
      this.#noProgressBackoffUntilMs = 0;
      this.#parkedRefusalUntilMs = 0;
      this.#countedNoProgressTurnMs = turn.timestamp;
      this.#setState({ ...this.#state, noProgressStreak: 0, noProgressTurnMs: turn.timestamp });
    }
    return true;
  }

  #failNoProgress(): void {
    this.#setState({
      ...this.#state,
      active: false,
      status: "error",
      noProgressStreak: this.#noProgressStreak,
      lastReason: CONTINUATION_NO_PROGRESS_CAP_REASON,
      lastError: CONTINUATION_NO_PROGRESS_CAP_REASON,
    });
  }

  #setState(next: GoalState): void {
    const now = this.#now();
    let normalized = normalizeGoalState({ ...next, updatedAt: now });
    if (normalized.createdAt !== undefined) {
      normalized = {
        ...normalized,
        timeUsedSeconds: creationElapsedSeconds(normalized.createdAt, now),
      };
    }
    this.#persist?.(normalized);
    if (normalized.status !== "active") {
      this.#pendingContinuation = false;
    }
    this.#state = normalized;
  }
}
