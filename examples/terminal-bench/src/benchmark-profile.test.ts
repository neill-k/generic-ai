import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBenchmarkProfile } from "./benchmark-profile.js";

describe("runBenchmarkProfile", () => {
  it("writes deterministic Harbor-collected artifacts without invoking a nested sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-terminal-bench-"));
    const outputDir = join(root, "artifacts");
    const result = await runBenchmarkProfile({
      instruction: "Create hello.txt.",
      workspaceRoot: root,
      outputDir,
      now: () => "2026-04-26T00:00:00.000Z",
      createRunId: () => "run-1",
      runHarness: (options) => ({
        harnessId: options.harness.id,
        adapter: "pi",
        status: "succeeded",
        outputText: "Done.",
        envelope: {
          kind: "run-envelope",
          runId: "run-1",
          rootScopeId: "terminal-bench",
          mode: "sync",
          status: "succeeded",
          timestamps: {
            createdAt: "2026-04-26T00:00:00.000Z",
            startedAt: "2026-04-26T00:00:00.000Z",
            completedAt: "2026-04-26T00:00:00.000Z",
          },
        },
        events: [],
        projections: [
          {
            id: "projection-1",
            sequence: 1,
            type: "terminal.command.started",
            eventName: "plugin.generic-ai-runtime.pi.tool_execution_start",
            occurredAt: "2026-04-26T00:00:00.000Z",
            roleId: "builder",
            toolName: "bash",
            summary: "plugin.generic-ai-runtime.pi.tool_execution_start bash.",
            data: {
              toolName: "bash",
              command: "printf hello > hello.txt",
              cwd: root,
            },
          },
        ],
        artifacts: [
          {
            id: "canonical-events",
            kind: "events",
            uri: "generic-ai-artifact://run-1/harness/canonical-events",
            localPath: join(outputDir, "harness", "canonical-events.json"),
          },
        ],
        policyDecisions: [
          {
            id: "run-1:policy:nested-sandbox",
            runId: "run-1",
            actorId: "generic-ai",
            action: "create_nested_sandbox",
            resource: { kind: "sandbox", id: "nested" },
            effect: "deny",
            decision: "denied",
            reason: "Benchmark runs use the harness container as the execution boundary.",
            evidenceRefs: [],
          },
        ],
        hookDecisions: [],
      }),
    });

    expect(result.summary.status).toBe("passed");
    expect(result.policyDecisions[0]?.decision).toBe("denied");
    await expect(readFile(join(outputDir, "summary.json"), "utf-8")).resolves.toContain(
      '"runId": "run-1"',
    );
    await expect(readFile(join(outputDir, "trajectory.json"), "utf-8")).resolves.toContain(
      "ATIF-v1.4",
    );
    await expect(readFile(join(outputDir, "command-transcript.json"), "utf-8")).resolves.toContain(
      "printf hello > hello.txt",
    );
    await expect(readFile(join(outputDir, "command-transcript.md"), "utf-8")).resolves.toContain(
      "terminal.command.started",
    );
  });
});
