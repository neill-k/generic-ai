import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@generic-ai/sdk";
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
            data: { toolName: "bash" },
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

  it("clips benchmark command output, redacts raw logs, and writes command observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-terminal-bench-"));
    const outputDir = join(root, "artifacts");
    let deliveredOutput = "";
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("alpha super-secret-token omega", "utf8"));
        return { exitCode: 0 };
      },
    };
    const result = await runBenchmarkProfile({
      instruction: "Run a noisy command.",
      workspaceRoot: root,
      outputDir,
      env: {
        GENERIC_AI_PROVIDER_API_KEY: "super-secret-token",
      },
      now: () => "2026-04-26T00:00:00.000Z",
      createRunId: () => "run-clip",
      maxCommandOutputBytes: 8,
      terminalOperations: operations,
      runHarness: async (options) => {
        const terminal = options.capabilities?.terminalTools as
          | {
              run(request: { readonly command: string }): Promise<{ readonly output: string }>;
            }
          | undefined;
        const commandResult = await terminal?.run({
          command: "noisy",
        });
        deliveredOutput = commandResult?.output ?? "";
        return {
          harnessId: options.harness.id,
          adapter: "pi",
          status: "succeeded",
          outputText: "Done.",
          envelope: {
            kind: "run-envelope",
            runId: "run-clip",
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
          projections: [],
          artifacts: [],
          policyDecisions: [],
        };
      },
    });

    expect(deliveredOutput).toContain("alpha [R");
    expect(deliveredOutput).toContain("output clipped");
    expect(result.summary.outputClippedCommandCount).toBe(1);
    expect(result.commandObservations[0]?.output.clipped).toBe(true);
    await expect(readFile(join(outputDir, "command-observations.json"), "utf-8")).resolves.toContain(
      '"output"',
    );
    const rawLog = result.commandObservations[0]?.output.localPath;
    expect(rawLog).toBeDefined();
    await expect(readFile(rawLog ?? "", "utf-8")).resolves.toBe("alpha [REDACTED] omega");
    expect(result.traceEvents.some((event) => event.summary.includes("output clipped"))).toBe(
      true,
    );
  });

  it("records timed-out benchmark commands as structured observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-terminal-bench-"));
    const outputDir = join(root, "artifacts");
    let deliveredOutput = "";
    let timeoutSeconds: number | undefined;
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        timeoutSeconds = options.timeout;
        return { exitCode: null };
      },
    };
    const result = await runBenchmarkProfile({
      instruction: "Run a slow command.",
      workspaceRoot: root,
      outputDir,
      now: () => "2026-04-26T00:00:00.000Z",
      createRunId: () => "run-timeout",
      commandTimeoutMs: 1500,
      terminalOperations: operations,
      runHarness: async (options) => {
        const terminal = options.capabilities?.terminalTools as
          | {
              run(request: { readonly command: string }): Promise<{ readonly output: string }>;
            }
          | undefined;
        const commandResult = await terminal?.run({
          command: "slow",
        });
        deliveredOutput = commandResult?.output ?? "";
        return {
          harnessId: options.harness.id,
          adapter: "pi",
          status: "succeeded",
          outputText: "Stopped after timeout.",
          envelope: {
            kind: "run-envelope",
            runId: "run-timeout",
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
          projections: [],
          artifacts: [],
          policyDecisions: [],
        };
      },
    });

    expect(timeoutSeconds).toBe(2);
    expect(deliveredOutput).toContain("command timed out");
    expect(result.summary.commandTimeoutCount).toBe(1);
    expect(result.commandObservations[0]).toMatchObject({
      status: "timed_out",
      timedOut: true,
      budgetExhausted: false,
      timeoutMs: 1500,
    });
  });
});
