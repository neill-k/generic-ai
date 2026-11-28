import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage, registerFauxProvider } from "@generic-ai/ai";
import { createSqliteRunStore, createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createModelBackground } from "./background.js";
import { summarizeCompanyCosts } from "./costs.js";
import { createModelCallLog, withPlanObserver } from "./model-calls.js";
import { createPlanLimit, PLAN_RESET_REASON } from "./plan-limit.js";
import { openSpendingLimits } from "./spend-limits.js";
import { createSqliteStorageContract } from "./storage.js";

// Model calls outside agent turns count toward usage, spending limits and the plan limit. The
// model here is the in-process faux provider: nothing calls a real model.

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-model-calls-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runStore = createSqliteRunStore({ path: path.join(dir, "runs.sqlite") });
  cleanups.push(() => runStore.close());
  const kv = createSqliteStorageContract(createSqliteStorage({ path: ":memory:" }));
  const limits = await openSpendingLimits({ kv, agentIds: () => ["ceo", "vp-ops"] });
  cleanups.push(() => limits.stop());
  const plan = await createPlanLimit({
    kv,
    source: async () => "claude_plan",
    apiKey: async () => undefined,
  });
  const provider = registerFauxProvider({ provider: "anthropic", models: [{ id: "scripted" }] });
  cleanups.push(() => provider.unregister());
  const model = provider.getModel("scripted");
  if (model === undefined) {
    throw new Error("The faux model did not register.");
  }
  return { runStore, limits, plan, provider, model };
}

describe("model calls outside turns", () => {
  it("count toward usage and spending limits", async () => {
    const { runStore, limits, provider, model } = await setup();
    const log = createModelCallLog({ runStore: limits.meter(runStore) });
    const pending: Promise<void>[] = [];
    const background = createModelBackground({
      model: "anthropic/scripted",
      resolveModel: () => model,
      onUsage: (usage, request) => {
        pending.push(
          log.record({
            ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
            purpose: request.purpose ?? "preferences",
            model: "anthropic/scripted",
            usage,
          }),
        );
      },
    });
    provider.setResponses([
      fauxAssistantMessage("A refined memory."),
      fauxAssistantMessage("No new preferences."),
    ]);
    await background({
      purpose: "dreaming",
      agentId: "vp-ops",
      system: "Refine.",
      prompt: "Notes.",
      maxTokens: 100,
    });
    await background({
      purpose: "preferences",
      system: "Scan.",
      prompt: "Messages.",
      maxTokens: 50,
    });
    await Promise.all(pending);

    const spent = limits.spent("vp-ops", "day");
    expect(spent.tokens).toBeGreaterThan(0);
    // Company-wide work counts toward the company, not any one agent.
    expect(limits.spent(undefined, "day").tokens).toBeGreaterThan(spent.tokens);

    const costs = await summarizeCompanyCosts(runStore);
    expect(costs.byAgent.map((row) => row.key).sort()).toEqual(["unknown", "vp-ops"]);
    expect(costs.byModel.map((row) => row.key)).toEqual(["anthropic/scripted"]);
    expect(costs.totals.responses).toBe(2);

    await limits.setAgentLimit("vp-ops", { period: "day", maxTokens: 1 });
    expect(limits.holdFor("vp-ops")).toMatchObject({ kind: "agent-limit" });
  });

  it("notice the plan's usage limit", async () => {
    const { plan, provider, model } = await setup();
    const background = withPlanObserver(
      createModelBackground({ model: "anthropic/scripted", resolveModel: () => model }),
      () => "anthropic/scripted",
      async (modelRef, error) => {
        await plan.observe(
          { model: modelRef },
          error === undefined
            ? { status: "succeeded", outputText: "" }
            : { status: "failed", outputText: "", failureMessage: String(error) },
        );
      },
    );
    provider.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"Claude AI usage limit reached|4102444800"}}',
      }),
    ]);
    await expect(
      background({ system: "Scan.", prompt: "Messages.", maxTokens: 50 }),
    ).rejects.toThrow(/rate_limit_error/);
    expect(await plan.holdFor("ceo")).toMatchObject({
      kind: "plan-reset",
      reason: PLAN_RESET_REASON,
      until: new Date(4102444800 * 1000).toISOString(),
    });
  });
});
