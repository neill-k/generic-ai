import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type Context,
  type FauxProviderRegistration,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import {
  type AgentHarnessConfig,
  type AgentHarnessHostTool,
  type AgentHarnessPolicyEvaluator,
  defineTool,
  type PolicyDecisionRecord,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";
import { type CreateAgentHarnessOptions, createAgentHarness } from "./agent-harness.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

/** A harness on the native adapter whose model answers from `responses`, in order. */
function fauxHarness(
  config: Omit<AgentHarnessConfig, "model" | "adapter">,
  responses: FauxResponseStep[],
  options: Omit<CreateAgentHarnessOptions, "native"> = {},
) {
  const provider = registerFauxProvider({ models: [{ id: "test-model" }] });
  registrations.push(provider);
  provider.setResponses(responses);
  const model = provider.getModel("test-model");
  if (model === undefined) {
    throw new Error("faux model missing");
  }
  return createAgentHarness(
    { ...config, adapter: "native", model: "faux/test-model" },
    { ...options, native: { resolveModel: (): Model => model } },
  );
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

function lastUserText(context: Context): string {
  const user = context.messages.filter((message) => message.role === "user").at(-1);
  if (user === undefined) {
    return "";
  }
  return typeof user.content === "string"
    ? user.content
    : user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function call(name: string, args: JsonObject): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function stop(response: string): AssistantMessage {
  return call(STOP_AND_RESPOND_TOOL_NAME, { response });
}

/** Record the tools offered on this turn, then answer. */
function recording(
  toolSets: string[][],
  answer: AssistantMessage | ((context: Context) => AssistantMessage),
): FauxResponseStep {
  return (context) => {
    toolSets.push(toolNames(context));
    return typeof answer === "function" ? answer(context) : answer;
  };
}

function capabilityTool(name: string, effects: Parameters<typeof withAgentHarnessToolEffects>[1]) {
  return withAgentHarnessToolEffects(
    {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
    },
    effects,
  );
}

describe("createAgentHarness", () => {
  it("can run with a non-native adapter when registered explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-external-"));
    const harness = createAgentHarness(
      {
        id: "external-harness",
        adapter: "external",
      },
      {
        adapters: {
          external: {
            id: "mock-external-adapter",
            kind: "external",
            run: async (input) => ({
              harnessId: input.harness.id,
              adapter: "external",
              status: "succeeded",
              outputText: "external adapter output",
              envelope: {
                kind: "run-envelope",
                runId: input.runId ?? "run-external",
                rootScopeId: input.rootScopeId ?? "scope/root",
                rootAgentId: input.rootAgentId ?? "root",
                mode: "sync",
                status: "succeeded",
                timestamps: {
                  createdAt: new Date().toISOString(),
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                },
                eventStream: {
                  kind: "event-stream-reference",
                  streamId: input.runId ?? "run-external",
                },
              },
              events: [],
              projections: [],
              artifacts: [],
              policyDecisions: [],
              hookDecisions: [],
            }),
          },
        },
      },
    );

    const result = await harness.run({
      instruction: "Run externally",
      workspaceRoot: root,
    });

    expect(result.status).toBe("succeeded");
    expect(result.adapter).toBe("external");
    expect(result.outputText).toBe("external adapter output");
  });

  it("runs on the native adapter when the config names none", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-default-"));
    const provider = registerFauxProvider({ models: [{ id: "test-model" }] });
    registrations.push(provider);
    provider.setResponses([stop("native by default")]);
    const model = provider.getModel("test-model");
    const harness = createAgentHarness(
      { id: "default-harness", model: "faux/test-model" },
      { native: { resolveModel: () => model as Model } },
    );
    const result = await harness.run({ instruction: "Hello", workspaceRoot: root });
    expect(result.status).toBe("succeeded");
    expect(result.adapter).toBe("native");
    expect(result.outputText).toBe("native by default");
  });

  it("passes role-filtered tools into root and delegated sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-"));
    const toolSets: string[][] = [];
    const harness = fauxHarness(
      { id: "test-harness", policyProfile: "benchmark-container", allowMcp: false },
      [
        recording(toolSets, call("delegate_agent", { roleId: "builder", task: "write the answer" })),
        recording(toolSets, stop("builder done")),
        recording(toolSets, call("delegate_agent", { roleId: "verifier", task: "run the check" })),
        recording(toolSets, stop("verifier done")),
        recording(toolSets, stop("root done")),
      ],
    );

    const result = await harness.run({
      instruction: "Test delegation.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      capabilities: {
        terminalTools: { tool: capabilityTool("bash", ["process.spawn", "fs.read", "fs.write"]) },
        fileTools: {
          piTools: [capabilityTool("read", ["fs.read"]), capabilityTool("write", ["fs.write"])],
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("root done");
    const [rootTools, builderTools, , verifierTools] = toolSets;
    expect(rootTools).toContain("read");
    expect(rootTools).toContain("delegate_agent");
    expect(rootTools).toContain(STOP_AND_RESPOND_TOOL_NAME);
    expect(rootTools).not.toContain("bash");
    expect(rootTools).not.toContain("write");
    expect(builderTools).toEqual(expect.arrayContaining(["bash", "read", "write"]));
    expect(verifierTools).toContain("bash");
    expect(verifierTools).toContain("read");
    expect(verifierTools).not.toContain("write");
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
    expect(new Set(result.events.map((event) => event.rootSessionId)).size).toBe(1);
    const deniedVerifierWrite = expect.objectContaining({
      actorId: "verifier",
      action: "bind_tool",
      decision: "denied",
    });
    expect(result.policyDecisions).toEqual(expect.arrayContaining([deniedVerifierWrite]));

    const policyArtifact = result.artifacts.find((artifact) => artifact.id === "policy-decisions");
    expect(policyArtifact?.localPath).toBeDefined();
    const artifactDecisions = JSON.parse(
      await readFile(policyArtifact?.localPath ?? "", "utf-8"),
    ) as readonly PolicyDecisionRecord[];
    expect(artifactDecisions).toEqual(expect.arrayContaining([deniedVerifierWrite]));
  });

  it("exposes MCP server tools to roles by effect: reads everywhere, writes only to builders", async () => {
    const runMcpHarness = async (harnessOptions: {
      readonly policyProfile?: "local-dev-full" | "benchmark-container";
      readonly allowMcp?: boolean;
    }) => {
      const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-mcp-"));
      const toolSets: string[][] = [];
      let harnessToolCalls = 0;
      const responses: FauxResponseStep[] = [];
      for (const roleId of ["planner", "builder", "verifier"]) {
        responses.push(recording(toolSets, call("delegate_agent", { roleId, task: "use MCP" })));
        responses.push(recording(toolSets, stop("role done")));
      }
      responses.push(recording(toolSets, stop("root done")));
      const harness = fauxHarness({ id: "mcp-harness", ...harnessOptions }, responses);

      const result = await harness.run({
        instruction: "Use MCP.",
        workspaceRoot: root,
        capabilities: {
          mcp: {
            list: () => [],
            get: () => undefined,
            resolveLaunch: () => ({ transport: "stdio" }),
            describeForPrompt: () => "Available MCP servers:",
            async harnessTools() {
              harnessToolCalls += 1;
              return [
                capabilityTool("mcp__docs__search", ["mcp.read"]),
                capabilityTool("mcp__docs__update", ["mcp.read", "mcp.write"]),
                capabilityTool("mcp__mail__send_email", ["mcp.read", "mcp.write", "message.send"]),
                capabilityTool("mcp__cal__create_event", ["mcp.read", "mcp.write", "external.write"]),
              ];
            },
          },
        },
      });
      // Each role's first turn shows its tool set; the root's first turn is index 0.
      const [rootTools, plannerTools, , builderTools, , verifierTools] = toolSets;
      return {
        result,
        harnessToolCalls,
        toolSets,
        roles: { rootTools, plannerTools, builderTools, verifierTools },
      };
    };

    const local = await runMcpHarness({});
    expect(local.result.status).toBe("succeeded");
    expect(local.harnessToolCalls).toBe(1);
    const { rootTools, plannerTools, builderTools, verifierTools } = local.roles;
    for (const readOnlyRole of [rootTools, plannerTools, verifierTools]) {
      expect(readOnlyRole).toContain("mcp__docs__search");
      expect(readOnlyRole).not.toContain("mcp__docs__update");
      expect(readOnlyRole).not.toContain("mcp__mail__send_email");
      expect(readOnlyRole).not.toContain("mcp__cal__create_event");
    }
    expect(builderTools).toEqual(
      expect.arrayContaining([
        "mcp__docs__search",
        "mcp__docs__update",
        "mcp__mail__send_email",
        "mcp__cal__create_event",
        "mcp_registry",
      ]),
    );
    expect(local.result.policyDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "planner",
          action: "bind_tool",
          decision: "denied",
          reason: expect.stringContaining("mcp.write"),
        }),
      ]),
    );

    const mcpDenied = await runMcpHarness({ allowMcp: false });
    for (const tools of mcpDenied.toolSets) {
      expect(tools.some((tool) => tool.startsWith("mcp__"))).toBe(false);
    }

    const benchmark = await runMcpHarness({ policyProfile: "benchmark-container" });
    expect(benchmark.harnessToolCalls).toBe(0);
    for (const tools of benchmark.toolSets) {
      expect(tools.some((tool) => tool.startsWith("mcp__"))).toBe(false);
    }
  });

  it("honors a caller-provided policy evaluator during tool binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-policy-"));
    const toolSets: string[][] = [];
    const policy: AgentHarnessPolicyEvaluator = {
      async evaluate(input) {
        const denied = input.resource.id === "read";
        return {
          allowed: !denied,
          decision: {
            id: `${input.runId}:external:${input.resource.id ?? input.resource.kind}`,
            runId: input.runId,
            actorId: input.actorId,
            action: input.action,
            resource: input.resource,
            effect: denied ? "deny" : "allow",
            decision: denied ? "denied" : "allowed",
            reason: denied ? "External policy denied read." : "External policy allowed binding.",
            evidenceRefs: [],
          },
        };
      },
    };
    const harness = fauxHarness(
      { id: "policy-harness" },
      [recording(toolSets, stop("policy done"))],
      { policy },
    );

    const result = await harness.run({
      instruction: "Run with external policy.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      capabilities: {
        fileTools: { piTools: [capabilityTool("read", ["fs.read"])] },
        customTools: [capabilityTool("visible", ["handoff.read"])],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(toolSets[0]).toContain("visible");
    expect(toolSets[0]).not.toContain("read");
  });

  it("runs command lifecycle hooks around prompt submission with inspectable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-hooks-"));
    let observedPrompt = "";
    const hookScript = [
      "let input='';",
      "process.stdin.on('data',(chunk)=>input+=chunk);",
      "process.stdin.on('end',()=>{",
      "const context=JSON.parse(input);",
      "console.log(JSON.stringify({decision:'append_context',additionalContext:'hook saw '+context.event}));",
      "});",
    ].join("");
    const harness = fauxHarness(
      {
        id: "hooked-harness",
        execution: { turnMode: "single-turn" },
        hooks: {
          schemaVersion: "v1",
          hooks: [
            {
              id: "prompt-context",
              events: ["UserPromptSubmit"],
              handler: { type: "command", command: process.execPath, args: ["-e", hookScript] },
            },
          ],
        },
      },
      [
        (context) => {
          observedPrompt = lastUserText(context);
          return fauxAssistantMessage("hooked done");
        },
      ],
    );

    const result = await harness.run({
      instruction: "Test hook context.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("hooked done");
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

  it("blocks matching tool calls through PreToolUse hooks and tells the model why", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-hooks-"));
    const blockScript = "console.log(JSON.stringify({decision:'block',reason:'danger blocked'}));";
    let dangerRan = false;
    let blockedResult: { text: string; isError: boolean } | undefined;
    const harness = fauxHarness(
      {
        id: "blocking-harness",
        hooks: {
          schemaVersion: "v1",
          hooks: [
            {
              id: "block-danger",
              events: ["PreToolUse"],
              matcher: { toolName: "danger" },
              handler: { type: "command", command: process.execPath, args: ["-e", blockScript] },
            },
          ],
        },
      },
      [
        call("danger", { ok: true }),
        (context) => {
          const last = context.messages.at(-1);
          if (last?.role === "toolResult") {
            blockedResult = {
              text: last.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
              isError: last.isError,
            };
          }
          return stop("used something else");
        },
      ],
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
                dangerRan = true;
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

    expect(dangerRan).toBe(false);
    expect(blockedResult?.isError).toBe(true);
    expect(blockedResult?.text).toContain("danger blocked");
    expect(result.status).toBe("succeeded");
    expect(result.hookDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hookId: "block-danger", decision: "block", status: "blocked" }),
      ]),
    );
  });
});

describe("host tools", () => {
  it("returns host tool results and errors to the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-"));
    const calls: unknown[] = [];
    const toolResults: { text: string; isError: boolean }[] = [];
    const captureToolResult = (context: Context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        toolResults.push({
          text: last.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          isError: last.isError,
        });
      }
    };
    const hostTool: AgentHarnessHostTool = {
      name: "delegate_task",
      description: "Hand work to another agent.",
      parameters: {
        type: "object",
        properties: { tasks: { type: "array" } },
        required: ["tasks"],
      },
      effects: ["handoff.write"],
      execute(params) {
        calls.push(params);
        const tasks = params["tasks"];
        if (!Array.isArray(tasks) || tasks.length === 0) {
          return { text: "Pass at least one task.", isError: true };
        }
        return { text: `Recorded ${tasks.length} task(s).`, details: { count: tasks.length } };
      },
    };
    const harness = fauxHarness({ id: "host-tools", allowMcp: false }, [
      call("delegate_task", { tasks: [{ to: "analyst", task: "x" }] }),
      (context) => {
        captureToolResult(context);
        return call("delegate_task", { tasks: [] });
      },
      (context) => {
        captureToolResult(context);
        return stop("handed off");
      },
    ]);

    const result = await harness.run({
      instruction: "Delegate.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      hostTools: [hostTool],
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("handed off");
    expect(calls).toEqual([{ tasks: [{ to: "analyst", task: "x" }] }, { tasks: [] }]);
    expect(toolResults).toEqual([
      { text: "Recorded 1 task(s).", isError: false },
      { text: "Pass at least one task.", isError: true },
    ]);
  });
});
