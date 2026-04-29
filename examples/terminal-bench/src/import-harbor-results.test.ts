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
    await mkdir(join(trialDir, "artifacts", "generic-ai", "harness"), { recursive: true });
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
        type: "tool.invoked",
        sequence: 1,
        timestamp: "2026-04-26T00:00:00.000Z",
        runId: "run-1",
        actorId: "builder",
        artifactId: "stdout-log",
        summary: "Tool invoked: bash pytest.",
      },
      {
        id: "event-2",
        type: "actor.completed",
        sequence: 2,
        timestamp: "2026-04-26T00:00:00.000Z",
        runId: "run-1",
        summary: "Agent completed.",
      },
    ]);
    await writeJson(
      join(trialDir, "artifacts", "generic-ai", "harness", "harness-projections.json"),
      [
        {
          id: "projection-1",
          sequence: 1,
          type: "terminal.command.started",
          eventName: "plugin.generic-ai-runtime.pi.tool_execution_start",
          occurredAt: "2026-04-26T00:00:01.000Z",
          roleId: "builder",
          toolName: "bash",
          summary: "Builder invoked bash.",
          data: { toolName: "bash" },
        },
        {
          id: "projection-2",
          sequence: 2,
          type: "policy.decision",
          eventName: "policy.decision",
          occurredAt: "2026-04-26T00:00:02.000Z",
          roleId: "generic-ai",
          summary: "Denied nested sandbox creation.",
          data: { policyDecisionId: "run-1:policy:nested-sandbox" },
        },
        {
          id: "projection-3",
          sequence: 3,
          type: "artifact.created",
          eventName: "artifact.created",
          occurredAt: "2026-04-26T00:00:03.000Z",
          roleId: "generic-ai",
          summary: "Wrote canonical harness projections.",
          data: { artifactId: "harness-projections" },
        },
      ],
    );
    await writeFile(join(trialDir, "verifier", "reward.txt"), "1\n", "utf-8");

    const outputDir = join(jobDir, "generic-ai-report");
    const result = await importHarborResults({
      jobDir,
      outputDir,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.trialResults).toHaveLength(1);
    expect(
      result.trialResults[0]?.metrics.find((metric) => metric.metricId === "reward")?.value,
    ).toBe(0);
    expect(
      result.trialResults[0]?.metrics.find((metric) => metric.metricId === "success")?.value,
    ).toBe(0);
    expect(result.report.insufficientEvidence).toHaveLength(1);
    expect(result.trialResults[0]?.traceEvents.some((event) => event.type === "tool.invoked")).toBe(
      true,
    );
    expect(
      result.trialResults[0]?.traceEvents.some((event) => event.type === "policy.decision"),
    ).toBe(true);
    expect(
      result.trialResults[0]?.traceEvents.some((event) => event.type === "artifact.created"),
    ).toBe(true);
    await expect(
      readFile(join(outputDir, "trial-harness-projections.json"), "utf-8"),
    ).resolves.toContain("terminal.command.started");
    await expect(
      readFile(join(outputDir, "trial-harness-projections.md"), "utf-8"),
    ).resolves.toContain("Builder invoked bash.");
    expect(result.trialTranscripts[0]?.entries[0]?.sourceType).toBe("tool.invoked");
    await expect(
      readFile(join(outputDir, "trial-command-transcripts.md"), "utf-8"),
    ).resolves.toContain("Tool invoked: bash pytest.");
    await expect(
      readFile(join(outputDir, "trial-command-transcripts.json"), "utf-8"),
    ).resolves.toContain("stdout-log");
    await expect(readFile(join(outputDir, "benchmark-report.md"), "utf-8")).resolves.toContain(
      "## Insufficient Evidence",
    );
  });
});
