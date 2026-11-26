import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import type { UsageRecordedEventData } from "@generic-ai/sdk";
import { SessionManager } from "@generic-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import { createCanonicalEventStream } from "../events/index.js";
import { createUsageMeter, isUsageBudgetExceededError } from "../usage/index.js";
import { runCapabilityNativeAgentSession } from "./native-session.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

const filler = "x".repeat(4_000);
const compaction = { reserveTokens: 1_000, keepRecentTokens: 1_500 };

/** A session whose history is already past the compaction threshold of a 4,000-token window. */
async function fullSession(): Promise<{
  provider: FauxProviderRegistration;
  model: Model;
  manager: SessionManager;
}> {
  const provider = registerFauxProvider({ models: [{ id: "small-window", contextWindow: 4_000 }] });
  registrations.push(provider);
  const model = provider.getModel();
  const manager = SessionManager.inMemory("/tmp/work");
  provider.setResponses([
    fauxAssistantMessage(`One ${filler}`),
    fauxAssistantMessage(`Two ${filler}`),
    fauxAssistantMessage(`Three ${filler}`),
  ]);
  for (const prompt of ["First", "Second", "Third"]) {
    await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model,
      capabilities: {},
      prompt: `${prompt} ${filler}`,
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
    });
  }
  return { provider, model, manager };
}

describe("native session usage metering", () => {
  it("meters the compaction summary call as well as the turn", async () => {
    const { provider, model, manager } = await fullSession();
    provider.setResponses([fauxAssistantMessage("Summary."), fauxAssistantMessage("Done.")]);
    const eventStream = createCanonicalEventStream({});
    const meter = createUsageMeter({ eventStream });

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model,
      capabilities: {},
      prompt: "Fourth",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction,
      retry: false,
      eventStream,
      usageMeter: meter,
      usageAttribution: { roleId: "builder" },
    });

    expect(result.outputText).toBe("Done.");
    expect(result.events.map((event) => event.name)).toContain(
      "plugin.generic-ai-runtime.native.compaction",
    );
    const recorded = result.events
      .filter((event) => event.name === "usage.recorded")
      .map((event) => event.data as UsageRecordedEventData);
    expect(recorded.map((data) => [data.purpose, data.roleId])).toEqual([
      ["compaction", "builder"],
      [undefined, "builder"],
    ]);
    expect(recorded[0]?.usage.totalTokens).toBeGreaterThan(0);
    const summary = meter.summary();
    expect(summary.totals.responses).toBe(2);
    expect(summary.totals.totalTokens).toBe(
      recorded.reduce((sum, data) => sum + data.usage.totalTokens, 0),
    );
  });

  it("stops before the next model call when the compaction reaches the budget", async () => {
    const { provider, model, manager } = await fullSession();
    provider.setResponses([fauxAssistantMessage("Summary."), fauxAssistantMessage("Done.")]);
    const meter = createUsageMeter({ budget: { maxTokens: 1 } });
    const callsBefore = provider.state.callCount;

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model,
      capabilities: {},
      prompt: "Fourth",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction,
      retry: false,
      usageMeter: meter,
    });

    expect(isUsageBudgetExceededError(meter.exceeded)).toBe(true);
    expect(result.failureMessage).toMatch(/budget/i);
    expect(result.outputText).toBeUndefined();
    // Only the summary call was made.
    expect(provider.state.callCount - callsBefore).toBe(1);
    expect(meter.summary().totals.responses).toBe(1);
  });
});
