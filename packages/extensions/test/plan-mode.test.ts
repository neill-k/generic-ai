// Cases adapted from pi (badlogic/pi-mono, packages/coding-agent/test/plan-mode-extension.test.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// pi's plan mode swaps the active tools and asks through the TUI what to do with a plan. This one
// is headless: it blocks write tools during planning and the host runs the plan with `execute()`.

import { Agent, type AgentMessage, type AgentTool } from "@generic-ai/agent";
import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { createPlanMode, PLAN_MODE_CONTEXT_MARKER, type PlanModeState } from "../src/plan-mode.js";
import { ExtensionRunner } from "../src/runner.js";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
  for (const registration of registrations.splice(0)) registration.unregister();
});

function tool(name: string, calls: string[]): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { command: { type: "string" } } },
    execute: async (_id, params) => {
      calls.push(`${name}:${(params as { command?: string }).command ?? ""}`);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

function text(message: AgentMessage | undefined): string {
  if (message === undefined || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function setup(options: Parameters<typeof createPlanMode>[0] = {}) {
  const provider = registerFauxProvider({ models: [{ id: "plan-model" }] });
  registrations.push(provider);
  const calls: string[] = [];
  const agent = new Agent({
    initialState: {
      model: provider.getModel(),
      systemPrompt: "Base.",
      tools: ["read", "bash", "edit", "write", "echo_tool"].map((name) => tool(name, calls)),
    },
  });
  const planMode = createPlanMode(options);
  const runner = new ExtensionRunner();
  await runner.load(planMode.extension, "<inline:plan-mode>");
  runner.bindAgent(agent);
  const prompt = (input: string) => runner.runPrompt(input, (value) => agent.prompt(value));
  return { provider, agent, planMode, calls, prompt };
}

describe("plan mode", () => {
  it("toggles with /plan without calling the model", async () => {
    const { planMode, prompt, provider } = await setup();
    expect(planMode.state().phase).toBe("off");
    expect(await prompt("/plan")).toEqual({ kind: "handled", command: "plan" });
    expect(planMode.state().phase).toBe("planning");
    await prompt("/plan");
    expect(planMode.state().phase).toBe("off");
    await prompt("/plan on");
    expect(planMode.state().phase).toBe("planning");
    await prompt("/plan off");
    expect(planMode.state().phase).toBe("off");
    expect(provider.state.callCount).toBe(0);
  });

  it("blocks write tools and unsafe bash while planning, and keeps other tools", async () => {
    const { planMode, prompt, provider, agent, calls } = await setup({ enabled: true });
    let seen: Context | undefined;
    provider.setResponses([
      (context) => {
        seen = context;
        return fauxAssistantMessage(
          [
            fauxToolCall("read", {}),
            fauxToolCall("edit", {}),
            fauxToolCall("write", {}),
            fauxToolCall("bash", { command: "ls -la" }),
            fauxToolCall("bash", { command: "rm -rf build" }),
            fauxToolCall("echo_tool", {}),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("This file defines the command-line argument parser."),
    ]);
    await prompt("Look around.");

    expect(text(seen?.messages.at(-2))).toContain(PLAN_MODE_CONTEXT_MARKER);
    expect(calls).toEqual(["read:", "bash:ls -la", "echo_tool:"]);
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => text(message))).toEqual([
      "ok",
      "Plan mode: edit is disabled. Use /plan to leave plan mode first.",
      "Plan mode: write is disabled. Use /plan to leave plan mode first.",
      "ok",
      "Plan mode: command blocked (not allowlisted). Use /plan to leave plan mode first.\nCommand: rm -rf build",
      "ok",
    ]);
    // No plan in the answer: nothing to execute.
    expect(planMode.state().todos).toEqual([]);
    expect(planMode.execute()).toBeUndefined();
  });

  it("extracts the plan, then executes it with full access and tracks [DONE:n]", async () => {
    const plans: PlanModeState["todos"][] = [];
    const states: PlanModeState[] = [];
    const { planMode, prompt, provider, calls } = await setup({
      enabled: true,
      onPlan: (todos) => plans.push(todos),
      onStateChange: (state) => states.push(state),
    });
    provider.setResponses([
      fauxAssistantMessage(
        "Plan:\n1. Inspect the current implementation\n2. Add a regression test",
      ),
    ]);
    await prompt("Plan the fix.");
    expect(plans).toHaveLength(1);
    expect(planMode.state()).toEqual({
      phase: "planning",
      todos: [
        { step: 1, text: "Inspect the current implementation", completed: false },
        { step: 2, text: "A regression test", completed: false },
      ],
    });

    const execution = planMode.execute();
    expect(execution).toContain("Start with: Inspect the current implementation");
    expect(planMode.state().phase).toBe("executing");

    let executionContext = "";
    provider.setResponses([
      (context) => {
        executionContext = context.messages.map((message) => text(message)).join("\n");
        return fauxAssistantMessage([fauxToolCall("edit", {})], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Inspected it. [DONE:1]"),
    ]);
    await prompt(execution ?? "");
    // The plan-mode instructions are gone, the execution context is there, and edits run.
    expect(executionContext).not.toContain(PLAN_MODE_CONTEXT_MARKER);
    expect(executionContext).toContain("[EXECUTING PLAN - Full tool access enabled]");
    expect(calls).toEqual(["edit:"]);
    expect(planMode.state().todos.map((todo) => todo.completed)).toEqual([true, false]);

    provider.setResponses([fauxAssistantMessage("All steps complete.")]);
    await prompt("Continue.");
    expect(planMode.state().phase).toBe("off");
    expect(planMode.state().todos.every((todo) => todo.completed)).toBe(true);
    expect(states.at(-1)?.phase).toBe("off");
  });

  it("starts execution from /plan execute and restores a saved state", async () => {
    const saved: PlanModeState = {
      phase: "planning",
      todos: [{ step: 1, text: "Inspect the current implementation", completed: false }],
    };
    const { planMode, prompt } = await setup({ initialState: saved });
    expect(planMode.state()).toEqual(saved);
    await prompt("/plan execute");
    expect(planMode.state().phase).toBe("executing");
    planMode.disable();
    expect(planMode.state()).toEqual({ phase: "off", todos: [] });
  });
});
