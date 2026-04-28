import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import {
  defineTool,
  type PolicyDecisionRecord,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";
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

  it("runs command lifecycle hooks around prompt submission with inspectable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-hooks-"));
    let observedPrompt = "";
    const messages: unknown[] = [];
    const hookScript = [
      "let input='';",
      "process.stdin.on('data',(chunk)=>input+=chunk);",
      "process.stdin.on('end',()=>{",
      "const context=JSON.parse(input);",
      "console.log(JSON.stringify({decision:'append_context',additionalContext:'hook saw '+context.event}));",
      "});",
    ].join("");
    const harness = createAgentHarness(
      {
        id: "hooked-harness",
        adapter: "pi",
        model: "fake-model",
        hooks: {
          schemaVersion: "v1",
          hooks: [
            {
              id: "prompt-context",
              events: ["UserPromptSubmit"],
              handler: {
                type: "command",
                command: process.execPath,
                args: ["-e", hookScript],
              },
            },
          ],
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
          createAgentSession: async () =>
            ({
              session: {
                sessionId: "session-hooks",
                messages,
                subscribe() {
                  return () => undefined;
                },
                async prompt(prompt: string) {
                  observedPrompt = prompt;
                  messages.push({ role: "assistant", content: "hooked done" });
                },
              },
            }) as never,
        },
      },
    );

    const result = await harness.run({
      instruction: "Test hook context.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
    });

    expect(result.status).toBe("succeeded");
    expect(observedPrompt).toContain("Additional hook context");
    expect(observedPrompt).toContain("hook saw UserPromptSubmit");
    expect(result.hookDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "prompt-context",
          decision: "append_context",
          status: "appended_context",
        }),
      ]),
    );
    expect(result.projections.some((projection) => projection.type === "hook.decision")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.id === "hook-decisions")).toBe(true);
  });

  it("blocks matching tool calls through PreToolUse hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-hooks-"));
    const blockScript = "console.log(JSON.stringify({decision:'block',reason:'danger blocked'}));";
    const harness = createAgentHarness(
      {
        id: "blocking-harness",
        adapter: "pi",
        model: "fake-model",
        hooks: {
          schemaVersion: "v1",
          hooks: [
            {
              id: "block-danger",
              events: ["PreToolUse"],
              matcher: {
                toolName: "danger",
              },
              handler: {
                type: "command",
                command: process.execPath,
                args: ["-e", blockScript],
              },
            },
          ],
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
          createAgentSession: async (options) =>
            ({
              session: {
                sessionId: "session-blocked",
                messages: [],
                subscribe() {
                  return () => undefined;
                },
                async prompt() {
                  const danger = options?.customTools?.find((tool) => tool.name === "danger");
                  await danger?.execute(
                    "tool-call-1",
                    { ok: true },
                    undefined,
                    undefined,
                    {} as never,
                  );
                },
              },
            }) as never,
        },
      },
    );

    const result = await harness.run({
      instruction: "Use the dangerous tool.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      capabilities: {
        customTools: [
          withAgentHarnessToolEffects(
            defineTool({
              name: "danger",
              label: "Danger",
              description: "Dangerous test tool.",
              parameters: Type.Object({ ok: Type.Boolean() }),
              async execute() {
                return {
                  content: [{ type: "text" as const, text: "danger ok" }],
                  details: { ok: true },
                };
              },
            }),
            ["handoff.read"],
          ),
        ],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.failureMessage).toContain("danger blocked");
    expect(result.hookDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "block-danger",
          decision: "block",
          status: "blocked",
        }),
      ]),
    );
  });
});
