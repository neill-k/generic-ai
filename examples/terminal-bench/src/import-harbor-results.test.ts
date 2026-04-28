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
    await mkdir(jobDir, { recursive: true });
    await writeJson(join(jobDir, "config.json"), {
      job_name: "generic-ai-terminal-bench-validation",
      n_attempts: 5,
      datasets: [
        {
          name: "terminal-bench/terminal-bench-2",
          task_names: ["task-one"],
        },
      ],
    });

    for (const [trialId, reward] of [
      ["task-one__attempt-1", 0],
      ["task-one__attempt-2", 1],
    ] as const) {
      const trialDir = join(jobDir, trialId);
      await mkdir(join(trialDir, "verifier"), { recursive: true });
      await mkdir(join(trialDir, "artifacts", "generic-ai"), { recursive: true });
      await writeJson(join(trialDir, "result.json"), {
        n_trials: 1,
        timeout_multiplier: 1,
        verifier_result: { rewards: { reward } },
        duration_sec: 12,
      });
      await writeJson(join(trialDir, "artifacts", "generic-ai", "trace-events.json"), [
        {
          id: `${trialId}:event-1`,
          type: "actor.completed",
          sequence: 1,
          timestamp: "2026-04-26T00:00:00.000Z",
          runId: "run-1",
          summary: "Agent completed.",
        },
      ]);
      await writeFile(join(trialDir, "verifier", "reward.txt"), `${reward}\n`, "utf-8");
    }

    const outputDir = join(jobDir, "generic-ai-report");
    const result = await importHarborResults({
      jobDir,
      outputDir,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.trialResults).toHaveLength(2);
    expect(
      result.trialResults[0]?.metrics.find((metric) => metric.metricId === "reward")?.value,
    ).toBe(0);
    expect(
      result.trialResults[0]?.metrics.find((metric) => metric.metricId === "success")?.value,
    ).toBe(0);
    expect(result.validation.gate).toBe("validation");
    expect(result.validation.pinnedTaskSet.taskNames).toEqual(["task-one"]);
    expect(result.validation.reward.values).toEqual([0, 1]);
    expect(result.validation.reward.standardDeviation).toBeCloseTo(Math.SQRT1_2, 4);
    expect(result.validation.flakeSignals).toHaveLength(1);
    expect(result.report.insufficientEvidence).toHaveLength(1);
    await expect(readFile(join(outputDir, "benchmark-report.md"), "utf-8")).resolves.toContain(
      "## Insufficient Evidence",
    );
    await expect(readFile(join(outputDir, "benchmark-report.md"), "utf-8")).resolves.toContain(
      "## Terminal-Bench Validation Gate",
    );
    await expect(readFile(join(outputDir, "validation-summary.json"), "utf-8")).resolves.toContain(
      "standardDeviation",
    );
  });
});
