import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { type PolicyDecisionRecord, withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createAgentHarness } from "./agent-harness.js";
import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";

async function callStopTool(
  options: {
    readonly customTools?: readonly {
      readonly name?: string;
      readonly execute?: unknown;
    }[];
  },
  response: string,
) {
  const stopTool = options.customTools?.find(
    (tool) => tool.name === STOP_AND_RESPOND_TOOL_NAME,
  );
  if (stopTool === undefined) {
    throw new Error("Expected stop_and_respond tool to be registered.");
  }

  if (typeof stopTool.execute !== "function") {
    throw new Error("Expected stop_and_respond tool to be executable.");
  }

  await (
    stopTool.execute as (
      toolCallId: string,
      params: { readonly response: string },
    ) => Promise<unknown> | unknown
  )("stop-1", { response });
}

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
                    await delegate?.execute(
                      "delegate-2",
                      { roleId: "verifier", task: "run the final check" },
                      undefined,
                      undefined,
                      {} as never,
                    );
                    await callStopTool(options, "root done");
                  } else {
                    await callStopTool(options, "builder done");
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
    expect(toolSets[0]).toContain("stop_and_respond");
    expect(toolSets[0]).not.toContain("bash");
    expect(toolSets[0]).not.toContain("write");
    expect(toolSets[1]).toEqual(expect.arrayContaining(["bash", "read", "write"]));
    expect(toolSets[2]).toContain("bash");
    expect(toolSets[2]).toContain("read");
    expect(toolSets[2]).not.toContain("write");
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
    expect(new Set(result.events.map((event) => event.rootSessionId))).toEqual(
      new Set(["session-1"]),
    );
    expect(
      result.events.some(
        (event) => event.name === "policy.decision" && event.sessionId === "session-3",
      ),
    ).toBe(true);
    expect(result.policyDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "verifier",
          action: "bind_tool",
          decision: "denied",
        }),
      ]),
    );

    const policyArtifact = result.artifacts.find((artifact) => artifact.id === "policy-decisions");
    expect(policyArtifact?.localPath).toBeDefined();
    const artifactDecisions = JSON.parse(
      await readFile(policyArtifact?.localPath ?? "", "utf-8"),
    ) as readonly PolicyDecisionRecord[];
    expect(artifactDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "verifier",
          action: "bind_tool",
          decision: "denied",
        }),
      ]),
    );
  });

  it("does not mention the stop tool when single-turn execution is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-single-turn-"));
    const prompts: string[] = [];
    const toolSets: string[][] = [];
    const harness = createAgentHarness(
      {
        id: "single-turn-harness",
        adapter: "pi",
        model: "fake-model",
        policyProfile: "benchmark-container",
        allowMcp: false,
        execution: {
          turnMode: "single-turn",
        },
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
            toolSets.push([...(options.tools ?? [])]);
            const messages: unknown[] = [{ role: "assistant", content: "single turn done" }];
            return {
              session: {
                sessionId: "session-single-turn",
                messages,
                subscribe() {
                  return () => undefined;
                },
                async prompt(prompt: string) {
                  prompts.push(prompt);
                },
              },
            } as never;
          },
        },
      },
    );

    const result = await harness.run({
      instruction: "Answer in one turn.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("single turn done");
    expect(toolSets[0]).not.toContain("stop_and_respond");
    expect(prompts[0]).not.toContain("stop_and_respond");
    expect(prompts[0]).toContain("single-turn compatibility");
  });
});
