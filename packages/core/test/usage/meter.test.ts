import type { AgentEvent } from "@generic-ai/agent";
import type { ModelUsage } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createCanonicalEventStream } from "../../src/events/index.js";
import {
  createUsageMeter,
  isUsageBudgetExceededError,
  type UsageBudgetExceededError,
} from "../../src/usage/index.js";

const context = {
  scopeId: "scope/root",
  runId: "run-1",
  rootSessionId: "session-root",
  sessionId: "session-root",
};

function usage(tokens: number, costUsd: number): ModelUsage {
  return {
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
  };
}

function assistantEnd(tokens: number, costUsd: number): AgentEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      responseId: "resp-1",
      usage: usage(tokens, costUsd),
      stopReason: "stop",
      timestamp: 0,
    },
  } as AgentEvent;
}

describe("usage meter", () => {
  it("emits a usage.recorded event per response with attribution", async () => {
    const stream = createCanonicalEventStream();
    const meter = createUsageMeter({ eventStream: stream });

    await meter.record(
      { ...context, agentId: "builder-1", roleId: "builder", goalId: "goal-1" },
      { provider: "openai", model: "gpt-5.5", usage: usage(120, 0.03), responseId: "r1" },
    );

    const [event] = stream.snapshot();
    expect(event?.name).toBe("usage.recorded");
    expect(event?.origin).toEqual({ namespace: "core", subsystem: "usage-meter" });
    expect(event?.data).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      agentId: "builder-1",
      roleId: "builder",
      goalId: "goal-1",
      responseId: "r1",
      usage: { totalTokens: 120 },
    });
    expect(meter.totals("run-1").totalTokens).toBe(120);
    expect(meter.summary().byGoal[0]?.goalId).toBe("goal-1");
    expect(meter.signal.aborted).toBe(false);
  });

  it("records assistant message_end events and ignores the rest", async () => {
    const meter = createUsageMeter();
    await meter.observeAgentEvent(context, assistantEnd(50, 0.01));
    await meter.observeAgentEvent(context, { type: "agent_start" } as AgentEvent);
    await meter.observeAgentEvent(context, {
      type: "message_end",
      message: { role: "user", content: "hi", timestamp: 0 },
    } as AgentEvent);

    const summary = meter.summary();
    expect(summary.totals.responses).toBe(1);
    expect(summary.byModel).toEqual([
      expect.objectContaining({ provider: "anthropic", model: "claude-opus-5-5" }),
    ]);
    expect(summary.byAgent[0]?.agentId).toBe("session-root");
  });

  it("binds to an agent's event subscription", async () => {
    const meter = createUsageMeter();
    let listener: ((event: AgentEvent) => Promise<void> | void) | undefined;
    const unsubscribe = meter.bindAgent(
      {
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      context,
    );
    await listener?.(assistantEnd(10, 0));
    unsubscribe();
    expect(listener).toBeUndefined();
    expect(meter.totals("run-1").responses).toBe(1);
  });

  it("stops the run once when the dollar cap is reached", async () => {
    const stream = createCanonicalEventStream();
    const seen: UsageBudgetExceededError[] = [];
    const meter = createUsageMeter({
      eventStream: stream,
      budget: { maxCostUsd: 0.05 },
      onBudgetExceeded: (error) => {
        seen.push(error);
      },
    });

    await meter.record(context, { provider: "p", model: "m", usage: usage(10, 0.03) });
    expect(meter.status("run-1").exceeded).toBe(false);
    expect(meter.status("run-1").remainingCostUsd).toBeCloseTo(0.02);
    expect(meter.signal.aborted).toBe(false);

    await meter.record(context, { provider: "p", model: "m", usage: usage(10, 0.03) });
    await meter.record(context, { provider: "p", model: "m", usage: usage(10, 0.03) });

    expect(meter.signal.aborted).toBe(true);
    expect(isUsageBudgetExceededError(meter.signal.reason)).toBe(true);
    expect(meter.exceeded).toBe(meter.signal.reason);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toMatch(/cost budget reached/);

    const names = stream.snapshot().map((event) => event.name);
    expect(names).toEqual([
      "usage.recorded",
      "usage.recorded",
      "usage.budget.exceeded",
      "usage.recorded",
    ]);
    const exceeded = stream.snapshot()[2];
    expect(exceeded?.data).toMatchObject({
      scope: "run",
      limits: { maxCostUsd: 0.05 },
      breaches: [{ limit: "cost_usd", max: 0.05 }],
    });
    // Spend after the stop is still counted: a cap bounds when the run stops, not what was paid.
    expect(meter.totals("run-1").responses).toBe(3);
  });

  it("enforces token caps per run, not across runs", async () => {
    const meter = createUsageMeter({ budget: { maxTokens: 100 } });
    await meter.record(
      { ...context, runId: "a" },
      { provider: "p", model: "m", usage: usage(60, 0) },
    );
    await meter.record(
      { ...context, runId: "b" },
      { provider: "p", model: "m", usage: usage(60, 0) },
    );
    expect(meter.signal.aborted).toBe(false);
    await meter.record(
      { ...context, runId: "a" },
      { provider: "p", model: "m", usage: usage(40, 0) },
    );
    expect(meter.signal.aborted).toBe(true);
    expect((meter.signal.reason as UsageBudgetExceededError).breaches).toEqual([
      { limit: "tokens", max: 100, used: 100 },
    ]);
  });

  it("recognizes budget errors by shape", () => {
    expect(isUsageBudgetExceededError(new Error("nope"))).toBe(false);
    expect(isUsageBudgetExceededError({ code: "budget_exceeded", breaches: [] })).toBe(true);
  });
});
