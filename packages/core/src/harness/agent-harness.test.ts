import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createAgentHarness } from "./agent-harness.js";

describe("createAgentHarness", () => {
  it("passes role-filtered tools into root and delegated Pi sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-"));
    const toolSets: string[][] = [];
    let sessionIndex = 0;
    const harness = createAgentHarness(
      {
        id: "test-harness",
        adapter: "pi",
        model: "fake-model",
        policyProfile: "benchmark-container",
        allowMcp: false,
      },
      {
        sessionInputs: {
          agentDir: root,
          authStorage: {} as never,
          modelRegistry: {} as never,
          model: {} as never,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory(),
        },
        factories: {
          createAgentSession: async (options) => {
            if (options === undefined) {
              throw new Error("Expected createAgentSession options.");
            }
            const sessionId = `session-${++sessionIndex}`;
            toolSets.push([...(options.tools ?? [])]);
            const messages: unknown[] = [];
            const listeners: ((event: unknown) => void)[] = [];
            return {
              session: {
                sessionId,
                messages,
                subscribe(listener: (event: never) => void) {
                  listeners.push(listener as (event: unknown) => void);
                  return () => undefined;
                },
                async prompt(prompt: string) {
                  for (const listener of listeners) {
                    listener({
                      type: "turn_start",
                    });
                  }
                  if (prompt.includes("root coordinator")) {
                    const delegate = options.customTools?.find(
                      (tool) => tool.name === "delegate_agent",
                    );
                    await delegate?.execute(
                      "delegate-1",
                      { roleId: "builder", task: "write the answer" },
                      undefined,
                      undefined,
                      {} as never,
                    );
                    messages.push({ role: "assistant", content: "root done" });
                  } else {
                    messages.push({ role: "assistant", content: "builder done" });
                  }
                  for (const listener of listeners) {
                    listener({
                      type: "turn_end",
                      toolResults: [],
                    });
                  }
                },
              },
            } as never;
          },
        },
      },
    );

    const result = await harness.run({
      instruction: "Test delegation.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      capabilities: {
        terminalTools: {
          tool: withAgentHarnessToolEffects(
            { name: "bash", description: "terminal", execute: async () => ({}) },
            ["process.spawn", "fs.read", "fs.write"],
          ),
        },
        fileTools: {
          piTools: [
            withAgentHarnessToolEffects(
              { name: "read", description: "read", execute: async () => ({}) },
              ["fs.read"],
            ),
            withAgentHarnessToolEffects(
              { name: "write", description: "write", execute: async () => ({}) },
              ["fs.write"],
            ),
          ],
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("root done");
    expect(toolSets[0]).toContain("read");
    expect(toolSets[0]).toContain("delegate_agent");
    expect(toolSets[0]).not.toContain("bash");
    expect(toolSets[0]).not.toContain("write");
    expect(toolSets[1]).toEqual(expect.arrayContaining(["bash", "read", "write"]));
    expect(result.projections.some((projection) => projection.type === "handoff.requested")).toBe(
      true,
    );
    expect(result.projections.some((projection) => projection.type === "policy.decision")).toBe(
      true,
    );
    expect(result.artifacts[0]?.uri).toMatch(/^generic-ai-artifact:\/\//);
    expect(result.artifacts[0]?.sha256).toHaveLength(64);
    expect(result.policyDecisions.some((decision) => decision.reason.includes("effect"))).toBe(
      true,
    );
  });
});
