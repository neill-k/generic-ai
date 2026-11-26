import { emptyUsageTotals } from "@generic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missingProviderKeys, NOT_RUN_PREFIX, runTemplateEvals } from "./evals.js";
import { EXIT_MISSING_KEY, main } from "./evals-cli.js";
import { createSpendCap } from "./spend.js";
import { loadCompanyTemplate } from "./templates.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("eval spend cap", () => {
  it("hands each turn what is left of the cap and says why it stopped", () => {
    const cap = createSpendCap({ maxTokens: 1_000, maxCostUsd: 1 });
    expect(cap.turnBudget()).toEqual({ maxTokens: 1_000, maxCostUsd: 1 });
    cap.record({ ...emptyUsageTotals, responses: 1, totalTokens: 400, costUsd: 0.25 });
    expect(cap.turnBudget()).toEqual({ maxTokens: 600, maxCostUsd: 0.75 });
    expect(cap.reason()).toBeUndefined();
    cap.recordModelUsage({
      input: 500,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 600,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    });
    expect(cap.exhausted()).toBe(true);
    expect(cap.reason()).toMatch(/spend cap was reached .*token budget reached \(1000 of 1000/);
    expect(cap.spent().responses).toBe(2);
  });

  it("has no turn budget when no cap is set", () => {
    expect(createSpendCap().turnBudget()).toBeUndefined();
    expect(createSpendCap().exhausted()).toBe(false);
  });

  // The replay model reports estimated usage, so the cap bites offline exactly as it would live.
  it("stops the turn in flight at the cap and skips the attempts after it", async () => {
    const spendCap = createSpendCap({ maxTokens: 1 });
    const { report, notRun } = await runTemplateEvals({
      templateId: "back-office",
      mode: "replay",
      trials: 1,
      spendCap,
    });
    expect(spendCap.exhausted()).toBe(true);
    expect(report.gate.passed).toBe(false);
    // The first attempt ran into the cap; the second never started.
    expect(notRun).toBe(1);
    const [first, second] = report.results;
    expect(first?.usage?.budgetStopped).toBe(true);
    expect(second?.failureMessage).toContain(NOT_RUN_PREFIX);
    expect(report.efficiency.budgetStops).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("names the provider key a live run needs", async () => {
    const company = await loadCompanyTemplate("generic-corp");
    expect(missingProviderKeys(company, {})).toEqual([
      { provider: "anthropic", variables: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
    ]);
    expect(missingProviderKeys(company, { ANTHROPIC_API_KEY: "set" })).toEqual([]);
  });

  it("exits before spending anything when the key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: string) => {
      errors.push(message);
    });
    expect(await main(["--live", "--template", "generic-corp"])).toBe(EXIT_MISSING_KEY);
    expect(errors.join("\n")).toMatch(
      /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.*nothing was spent/,
    );
  });

  it("rejects caps that are not positive numbers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--max-usd", "0"])).toBe(2);
    expect(await main(["--max-tokens", "lots"])).toBe(2);
  });
});
