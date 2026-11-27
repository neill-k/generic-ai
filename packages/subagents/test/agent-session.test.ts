import { Agent } from "@generic-ai/agent";
import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentChildSessionFactory,
  createSubagentRoot,
  createSubagentTools,
  type SubagentEvent,
} from "../src/index.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function text(raw: unknown): string {
  const message = raw as Context["messages"][number] | undefined;
  if (message === undefined) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map((block) => ("text" in block ? block.text : "")).join("");
}

describe("subagents on real agents", () => {
  it("spawns a child, receives its message mid-run, and collects its answer", async () => {
    const provider = registerFauxProvider({ models: [{ id: "sub-model" }] });
    registrations.push(provider);
    const model = provider.getModel();
    const events: SubagentEvent[] = [];
    const root = createSubagentRoot({
      factory: createAgentChildSessionFactory({ model }),
      onEvent: (event) => events.push(event),
    });
    const parent = new Agent({
      initialState: { model, systemPrompt: "You lead.", tools: createSubagentTools(root) },
    });
    const unbind = root.bindAgent(parent);

    let childCalls = 0;
    let parentCalls = 0;
    let finalParentContext: Context | undefined;
    const respond = (context: Context) => {
      if (context.systemPrompt?.includes('subagent named "researcher"') === true) {
        childCalls += 1;
        return childCalls === 1
          ? fauxAssistantMessage(
              fauxToolCall("send_agent_message", { receiver_role: "parent", message: "halfway" }),
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("The answer is 42.");
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return fauxAssistantMessage(
          fauxToolCall("spawn_agent", { prompt: "Find the answer.", name: "researcher" }),
          { stopReason: "toolUse" },
        );
      }
      if (parentCalls === 2) {
        return fauxAssistantMessage(fauxToolCall("collect_agents", { timeout_ms: 5_000 }), {
          stopReason: "toolUse",
        });
      }
      finalParentContext = context;
      return fauxAssistantMessage("Researcher says 42.");
    };
    provider.setResponses(Array.from({ length: 8 }, () => respond));

    await parent.prompt("Delegate the question.");
    unbind();

    const toolResults = parent.state.messages.filter((message) => message.role === "toolResult");
    const collected = JSON.parse(text(toolResults[1]));
    expect(collected.results).toMatchObject([
      {
        name: "researcher",
        status: "completed",
        answerText: "The answer is 42.",
        toolUseCount: 1,
        repliedSinceTask: true,
      },
    ]);
    // The child's message was steered into the parent's run.
    const delivered = finalParentContext?.messages.map((message) => text(message)) ?? [];
    expect(delivered).toContain("[agent-message from child:researcher]\n\nhalfway");
    expect(text(parent.state.messages.at(-1))).toBe("Researcher says 42.");
    expect(events.map((event) => event.type)).toEqual(["spawned", "message", "settled"]);
    expect(root.inbox.read()).toMatchObject([{ kind: "child-exited", sender: "researcher" }]);
  });

  it("rejects unknown models and cancels a running child", async () => {
    const provider = registerFauxProvider({ models: [{ id: "sub-model" }] });
    registrations.push(provider);
    const model = provider.getModel();
    const root = createSubagentRoot({ factory: createAgentChildSessionFactory({ model }) });

    await expect(root.children.spawn({ prompt: "x", model: "other/model" })).rejects.toThrow(
      'spawn_agent model "other/model" is not available',
    );

    let release: (() => void) | undefined;
    provider.setResponses([
      () =>
        new Promise((resolve) => {
          release = () => resolve(fauxAssistantMessage("late"));
        }),
    ]);
    await root.children.spawn({ prompt: "slow", name: "slow", model: "sub-model" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const deleted = await root.children.delete("slow");
    expect(deleted.subagent.status).toBe("cancelled");
    release?.();
  });

  it("gives children the messaging and progress tools but not deeper spawning at the limit", () => {
    const provider = registerFauxProvider({ models: [{ id: "sub-model" }] });
    registrations.push(provider);
    const names: string[][] = [];
    const root = createSubagentRoot({
      maxDepth: 1,
      factory: createAgentChildSessionFactory({
        model: provider.getModel(),
        onAgentCreated: (_request, agent) => names.push(agent.state.tools.map((tool) => tool.name)),
      }),
    });
    expect(createSubagentTools(root).map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "collect_agents",
      "list_agents",
      "delete_agent",
      "rename_agent",
      "send_agent_message",
      "read_inbox",
      "observe_agents",
      "get_agent",
      "recent_agent_messages",
    ]);
    provider.setResponses([fauxAssistantMessage("ok")]);
    return root.children.spawn({ prompt: "x" }).then(async () => {
      expect(names[0]).toEqual([
        "send_agent_message",
        "read_inbox",
        "observe_agents",
        "get_agent",
        "recent_agent_messages",
        "progress_note",
      ]);
      await root.children.collect([], 1_000);
    });
  });
});
