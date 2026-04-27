import { describe, expect, it } from "vitest";
import { buildHarborCommandPlan } from "./run-terminal-bench.js";

describe("buildHarborCommandPlan", () => {
  it("uses Harbor config runs and exposes the local Python adapter on PYTHONPATH", () => {
    const plan = buildHarborCommandPlan({
      profile: "smoke",
      model: "gpt-test",
      env: {},
    });

    expect(plan.command).toBe("harbor");
    expect(plan.args[0]).toBe("run");
    expect(plan.args[1]).toBe("-c");
    expect(plan.args[2]).toContain("smoke.job.yaml");
    expect(plan.env["PYTHONPATH"]).toContain("terminal-bench");
    expect(plan.env["GENERIC_AI_MODEL"]).toBe("gpt-test");
    expect(plan.env["GENERIC_AI_REPO_ROOT"]).toContain("generic-ai");
  });
});
