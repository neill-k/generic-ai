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
      createRuntime: () => ({
        adapter: "openai-codex",
        model: "gpt-test",
        run: async () => ({
          adapter: "openai-codex",
          model: "gpt-test",
          outputText: "Done.",
        }),
        stream: async function* () {
          yield {
            type: "response",
            response: {
              adapter: "openai-codex",
              model: "gpt-test",
              outputText: "Done.",
            },
          };
        },
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
  });
});
