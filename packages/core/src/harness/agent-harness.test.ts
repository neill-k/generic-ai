import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { type PolicyDecisionRecord, withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createAgentHarness } from "./agent-harness.js";

describe("createAgentHarness", () => {
  it("passes role-filtered tools into root and delegated Pi sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-"));
    const toolSets: string[][] = [];
    const rootPrompts: string[] = [];
    let sessionIndex = 0;
    const harness = createAgentHarness(
      {
        id: "test-harness",
        adapter: "pi",
        model: "fake-model",
        policyProfile: "benchmark-container",
        allowMcp: false,
        loop: {
          pattern: "thread-turn-tool-policy",
          stateModel: "thread-turn-item",
          entryStage: "thread-log",
          terminalStages: ["thread-log"],
          stages: [
            {
              id: "thread-log",
              kind: "state",
              description: "Durable turn history.",
            },
            {
              id: "context-builder",
              kind: "context-builder",
              roleRef: "planner",
              description: "Assemble the turn context.",
              readOnly: true,
            },
            {
              id: "controller",
              kind: "controller",
              roleRef: "planner",
              description: "Choose the next action.",
            },
          ],
          transitions: [
            { from: "thread-log", to: "context-builder", label: "replay" },
            { from: "context-builder", to: "controller", label: "context" },
            { from: "controller", to: "thread-log", label: "record" },
          ],
          invariants: ["Build context before routing tools."],
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
                  if (prompt.startsWith("You are the root coordinator")) {
                    rootPrompts.push(prompt);
                  }
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
    expect(rootPrompts[0]).toContain("Native agent loop structure:");
    expect(rootPrompts[0]).toContain("Pattern: thread-turn-tool-policy.");
    expect(rootPrompts[0]).toContain("State model: thread-turn-item.");
    expect(rootPrompts[0]).toContain(
      "- context-builder (context-builder -> role planner read-only)",
    );
    expect(toolSets[0]).toContain("read");
    expect(toolSets[0]).toContain("delegate_agent");
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
});
