import type { AssistantMessage } from "@generic-ai/ai";

import type { AutonomousStatus } from "./autonomous.js";
import type { AutonomousDriver, AutonomousStopReason } from "./gates.js";
import type { GoalDriver } from "./goal-driver.js";
import { createGoalContextText, type GoalState } from "./goals.js";

export type LongRunFollowUp =
  | { readonly kind: "continue"; readonly source: "goal" | "autonomous"; readonly text: string }
  | {
      readonly kind: "stop";
      readonly goal?: GoalState;
      readonly autonomous?: {
        readonly reason: AutonomousStopReason;
        readonly status: AutonomousStatus;
      };
    };

export interface LongRunControllerOptions {
  readonly goal?: GoalDriver | undefined;
  readonly autonomous?: AutonomousDriver | undefined;
  /** Wait out a goal's no-progress backoff instead of stopping. Default true. */
  readonly waitForBackoff?: boolean | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Decides what follows each finished turn of a session: an active thread goal continues until it is
 * complete, paused, budget-limited or failed; then autonomous mode continues until its gates pass or
 * a limit is reached.
 */
export class LongRunController {
  readonly goal: GoalDriver | undefined;
  readonly autonomous: AutonomousDriver | undefined;
  readonly #waitForBackoff: boolean;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  #budgetNoticeOwed = false;

  constructor(options: LongRunControllerOptions) {
    this.goal = options.goal;
    this.autonomous = options.autonomous;
    this.#waitForBackoff = options.waitForBackoff ?? true;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  /** Account one finished assistant message toward the goal budget and the autonomous limits. */
  accountMessage(message: AssistantMessage, messageId: string): void {
    this.autonomous?.accountMessage(message);
    if (this.goal === undefined || message.stopReason === "error") {
      return;
    }
    if (this.goal.recordAssistantUsage(messageId, message.usage) === "budget-reached") {
      this.#budgetNoticeOwed = true;
    }
  }

  async afterTurn(
    lastTurn: AssistantMessage | undefined,
    signal?: AbortSignal,
  ): Promise<LongRunFollowUp> {
    if (signal?.aborted || lastTurn?.stopReason === "aborted") {
      return this.#stop();
    }
    const goal = this.goal;
    if (goal !== undefined) {
      if (this.#budgetNoticeOwed) {
        this.#budgetNoticeOwed = false;
        if (goal.state.status === "budget_limited") {
          return {
            kind: "continue",
            source: "goal",
            text: createGoalContextText(goal.stateWithCreationElapsed(), "budget-limit"),
          };
        }
      }
      goal.continuationConsumed();
      let text = goal.nextContinuation(lastTurn);
      while (text === undefined && this.#waitForBackoff && goal.state.status === "active") {
        const wakeAt = goal.backoffWakeAt();
        if (wakeAt === undefined || signal?.aborted) {
          break;
        }
        await this.#sleep(Math.max(0, wakeAt - this.#now()), signal);
        if (signal?.aborted) {
          return this.#stop();
        }
        text = goal.nextContinuation();
      }
      if (text !== undefined) {
        return { kind: "continue", source: "goal", text };
      }
      if (goal.state.status === "active" || goal.state.status === "error") {
        return this.#stop();
      }
    }
    if (this.autonomous !== undefined && lastTurn !== undefined) {
      const followUp = await this.autonomous.afterTurn(lastTurn);
      if (followUp.kind === "continue") {
        return { kind: "continue", source: "autonomous", text: followUp.text };
      }
      if (followUp.kind === "stop") {
        return this.#stop({ reason: followUp.reason, status: followUp.status });
      }
    }
    return this.#stop();
  }

  #stop(autonomous?: {
    readonly reason: AutonomousStopReason;
    readonly status: AutonomousStatus;
  }): LongRunFollowUp {
    return {
      kind: "stop",
      ...(this.goal === undefined ? {} : { goal: this.goal.stateWithCreationElapsed() }),
      ...(autonomous === undefined ? {} : { autonomous }),
    };
  }
}
