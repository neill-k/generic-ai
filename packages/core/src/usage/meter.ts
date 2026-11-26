import type { AgentEvent } from "@generic-ai/agent";
import type { AssistantMessage } from "@generic-ai/ai";
import {
  createUsageLedger,
  evaluateUsageBudget,
  formatUsageBudgetBreach,
  hasUsageBudget,
  type ModelUsage,
  type UsageBudgetBreach,
  type UsageBudgetExceededEventData,
  type UsageBudgetLimits,
  type UsageBudgetStatus,
  type UsageLedger,
  type UsageRecordedEventData,
  type UsageSummary,
  type UsageTotals,
} from "@generic-ai/sdk";

import type { CanonicalEventContext, CanonicalEventStream } from "../events/index.js";

/** Thrown (and used as the abort reason) when a run reaches its token or dollar cap. */
export class UsageBudgetExceededError extends Error {
  readonly code = "budget_exceeded" as const;
  readonly breaches: readonly UsageBudgetBreach[];
  readonly totals: UsageTotals;

  constructor(breaches: readonly UsageBudgetBreach[], totals: UsageTotals) {
    super(`Run stopped: ${breaches.map(formatUsageBudgetBreach).join("; ")}.`);
    this.name = "UsageBudgetExceededError";
    this.breaches = breaches;
    this.totals = totals;
  }
}

export function isUsageBudgetExceededError(error: unknown): error is UsageBudgetExceededError {
  return (
    error instanceof UsageBudgetExceededError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "budget_exceeded" &&
      Array.isArray((error as { breaches?: unknown }).breaches))
  );
}

/** Who made a model call. Combined with the canonical event context on every usage event. */
export interface UsageAttribution {
  readonly agentId?: string;
  readonly roleId?: string;
  readonly goalId?: string;
}

export type UsageMeterContext = CanonicalEventContext & UsageAttribution;

/** The parts of a model response the meter reads. `AssistantMessage` satisfies it. */
export interface MeteredResponse {
  readonly provider: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly responseId?: string;
  readonly stopReason?: string;
  /** Why the call was made, when it is not an agent turn (for example `compaction`). */
  readonly purpose?: string;
}

export interface CreateUsageMeterOptions {
  /** Where `usage.recorded` and `usage.budget.exceeded` events go. Omit to meter silently. */
  readonly eventStream?: CanonicalEventStream;
  /** Token and dollar caps for the run. Omit for no caps. */
  readonly budget?: UsageBudgetLimits;
  /** Share a ledger across meters (for example one per tenant). Defaults to a fresh ledger. */
  readonly ledger?: UsageLedger;
  /** Called once, after the budget event is emitted and before the run is aborted. */
  readonly onBudgetExceeded?: (error: UsageBudgetExceededError) => void | Promise<void>;
}

/**
 * Meters one run. Every model response of every agent in the run goes through `record` (or
 * `observeAgentEvent` / `bindAgent`), which emits a `usage.recorded` event, updates the ledger, and
 * checks the run's caps. When a cap is reached the meter emits `usage.budget.exceeded` once and
 * aborts `signal` with a {@link UsageBudgetExceededError}, so every session that listens to the
 * signal stops after the response that crossed the cap. The response that crossed is still counted:
 * a cap bounds when the run stops, it cannot un-spend a response already paid for.
 */
export interface UsageMeter {
  /** Aborted with a {@link UsageBudgetExceededError} once a cap is reached. */
  readonly signal: AbortSignal;
  readonly budget?: UsageBudgetLimits;
  readonly ledger: UsageLedger;
  record(context: UsageMeterContext, response: MeteredResponse): Promise<UsageTotals>;
  /** Record assistant `message_end` events; ignores everything else. */
  observeAgentEvent(context: UsageMeterContext, event: AgentEvent): Promise<void>;
  /** Subscribe to an agent's events. Returns the unsubscribe function. */
  bindAgent(
    agent: { subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void },
    context: UsageMeterContext,
  ): () => void;
  /** The run's totals so far. */
  totals(runId: string): UsageTotals;
  status(runId: string): UsageBudgetStatus;
  /** Set once a cap has been reached. */
  readonly exceeded: UsageBudgetExceededError | undefined;
  summary(): UsageSummary;
}

function eventContext(context: UsageMeterContext): CanonicalEventContext {
  return {
    scopeId: context.scopeId,
    runId: context.runId,
    rootSessionId: context.rootSessionId,
    sessionId: context.sessionId,
    ...(context.parentSessionId === undefined ? {} : { parentSessionId: context.parentSessionId }),
    ...(context.delegationId === undefined ? {} : { delegationId: context.delegationId }),
  };
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "assistant" &&
    typeof (message as { usage?: unknown }).usage === "object"
  );
}

export function createUsageMeter(options: CreateUsageMeterOptions = {}): UsageMeter {
  const ledger = options.ledger ?? createUsageLedger();
  const controller = new AbortController();
  const budget = hasUsageBudget(options.budget) ? options.budget : undefined;
  let exceeded: UsageBudgetExceededError | undefined;

  const meter: UsageMeter = {
    signal: controller.signal,
    ...(budget === undefined ? {} : { budget }),
    ledger,
    get exceeded() {
      return exceeded;
    },
    async record(context, response) {
      const runTotals = ledger.record({
        runId: context.runId,
        sessionId: context.sessionId,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(context.roleId === undefined ? {} : { roleId: context.roleId }),
        ...(context.goalId === undefined ? {} : { goalId: context.goalId }),
      });
      const data: UsageRecordedEventData = {
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        agentId: context.agentId ?? context.sessionId,
        ...(context.roleId === undefined ? {} : { roleId: context.roleId }),
        ...(context.goalId === undefined ? {} : { goalId: context.goalId }),
        ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
        ...(response.stopReason === undefined ? {} : { stopReason: response.stopReason }),
        ...(response.purpose === undefined ? {} : { purpose: response.purpose }),
      };
      await options.eventStream?.emit({
        ...eventContext(context),
        name: "usage.recorded",
        origin: { subsystem: "usage-meter" },
        data,
      });

      if (budget !== undefined && exceeded === undefined) {
        const status = evaluateUsageBudget(runTotals, budget);
        if (status.exceeded) {
          const error = new UsageBudgetExceededError(status.breaches, runTotals);
          exceeded = error;
          const exceededData: UsageBudgetExceededEventData = {
            scope: "run",
            breaches: status.breaches,
            limits: budget,
            totals: runTotals,
          };
          await options.eventStream?.emit({
            ...eventContext(context),
            name: "usage.budget.exceeded",
            origin: { subsystem: "usage-meter" },
            data: exceededData,
          });
          await options.onBudgetExceeded?.(error);
          controller.abort(error);
        }
      }
      return runTotals;
    },
    async observeAgentEvent(context, event) {
      if (event.type !== "message_end" || !isAssistantMessage(event.message)) {
        return;
      }
      const message = event.message;
      await meter.record(context, {
        provider: message.provider,
        model: message.responseModel ?? message.model,
        usage: message.usage,
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        stopReason: message.stopReason,
      });
    },
    bindAgent(agent, context) {
      return agent.subscribe((event) => meter.observeAgentEvent(context, event));
    },
    totals(runId) {
      return ledger.runTotals(runId);
    },
    status(runId) {
      return evaluateUsageBudget(ledger.runTotals(runId), budget);
    },
    summary() {
      return ledger.summary();
    },
  };
  return meter;
}
