import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importHarborResults } from "./import-harbor-results.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("importHarborResults", () => {
  it("normalizes Harbor trial directories into Generic AI benchmark reports", async () => {
    const jobDir = join(tmpdir(), `generic-ai-harbor-job-${Date.now()}`);
    const trialDir = join(jobDir, "task-one__abc1234");
    await mkdir(join(trialDir, "verifier"), { recursive: true });
    await mkdir(join(trialDir, "artifacts", "generic-ai"), { recursive: true });
    await writeJson(join(jobDir, "config.json"), { job_name: "smoke" });
    await writeJson(join(trialDir, "result.json"), {
      n_trials: 1,
      timeout_multiplier: 1,
      verifier_result: { rewards: { reward: 0 } },
      duration_sec: 12,
    });
    await writeJson(join(trialDir, "artifacts", "generic-ai", "trace-events.json"), [
      {
        id: "event-1",
        type: "actor.completed",
        sequence: 1,
        timestamp: "2026-04-26T00:00:00.000Z",
        runId: "run-1",
        summary: "Agent completed.",
      },
    ]);
    await writeJson(join(trialDir, "artifacts", "generic-ai", "summary.json"), {
      commandTimeoutCount: 1,
      outputClippedCommandCount: 2,
      budgetExhaustedCommandCount: 0,
    });
    await writeFile(join(trialDir, "verifier", "reward.txt"), "1\n", "utf-8");

    const outputDir = join(jobDir, "generic-ai-report");
    const result = await importHarborResults({
      jobDir,
      outputDir,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.trialResults).toHaveLength(1);
    expect(result.trialResults[0]?.metrics.find((metric) => metric.metricId === "reward")?.value)
      .toBe(0);
    expect(result.trialResults[0]?.metrics.find((metric) => metric.metricId === "success")?.value)
      .toBe(0);
    expect(
      result.trialResults[0]?.metrics.find(
        (metric) => metric.metricId === "generic_ai_command_timeout_count",
      )?.value,
    ).toBe(1);
    expect(
      result.trialResults[0]?.metrics.find(
        (metric) => metric.metricId === "generic_ai_output_clipped_command_count",
      )?.value,
    ).toBe(2);
    expect(result.benchmark.guardrailMetrics).toContain("generic_ai_command_timeout_count");
    expect(result.report.insufficientEvidence).toHaveLength(1);
    await expect(readFile(join(outputDir, "benchmark-report.md"), "utf-8")).resolves.toContain(
      "## Insufficient Evidence",
    );
  });
});
