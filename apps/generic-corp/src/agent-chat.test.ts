import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type {
  AgentTaskExecutionInput,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { type CompanyConfig, createGenericCorpServer, type GenericCorpServer } from "./index.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const COMPANY: CompanyConfig = {
  name: "Test Corp",
  models: { ceo: "anthropic/claude-opus-5-5" },
  agents: [
    { id: "ceo", role: "ceo", title: "CEO" },
    { id: "vp-research", role: "vp-research", title: "VP of Research", reportsTo: "ceo" },
  ],
};

const GOAL = {
  objective: "Answer the owner.",
  definitionOfDone: ["The answer is handed in."],
  validators: [
    { id: "handed-in", kind: "output_schema", schema: { type: "object", required: ["summary"] } },
  ],
};

async function openServer(
  turn: (input: AgentTaskExecutionInput, server: GenericCorpServer) => Promise<string>,
) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-chat-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let server: GenericCorpServer | undefined;
  const executor: AgentTaskExecutor = async (input): Promise<AgentTaskExecutionResult> => {
    const use = (name: string, params: Record<string, unknown>) => {
      const tool = input.tools?.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        throw new Error(`${input.agentId} has no ${name} tool`);
      }
      return tool.execute(params as never, { toolCallId: name });
    };
    if (input.tools?.some((tool) => tool.name === "set_goal")) {
      await use("set_goal", GOAL);
    }
    const summary = await turn(input, server as GenericCorpServer);
    await use("submit_work", { summary, deliverables: [] });
    return { status: "succeeded", outputText: summary };
  };
  server = await createGenericCorpServer({
    environment: {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      trustProxyHeaders: false,
      insecureNoAuth: true,
      workers: false,
    },
    company: COMPANY,
    executor,
    authStore: createMemoryAuthStore(),
    log: () => undefined,
  });
  const opened = server;
  cleanups.push(() => opened.stop());
  return server;
}

async function say(server: GenericCorpServer, agentId: string, text: string) {
  const response = await server.fetch(
    new Request(`http://127.0.0.1/api/agents/${agentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
  return (await response.json()) as { message: { delivery: string; taskIds: string[] } };
}

describe("owner messages to any agent", () => {
  it("gives an idle agent a new request, tells a busy one at its next step, and tells the CEO", async () => {
    const steered: string[] = [];
    const ceoPrompts: string[] = [];
    const server = await openServer(async (input, current) => {
      if (input.agentId === "ceo") {
        ceoPrompts.push(input.prompt);
        return "Noted.";
      }
      // While the VP works on the first message, the owner sends a second.
      const second = await say(current, "vp-research", "Focus on Austin.");
      expect(second.message.delivery).toBe("current-work");
      steered.push(...((await input.steering?.()) ?? []));
      return "Austin it is.";
    });

    const first = await say(server, "vp-research", "Find a venue.");
    expect(first.message.delivery).toBe("new-request");
    await server.runtime.cascade.drain();

    expect(steered).toEqual(["Message from the owner while you work: Focus on Austin."]);
    const history = await (
      await server.fetch(new Request("http://127.0.0.1/api/agents/vp-research/messages"))
    ).json();
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0].reply).toMatchObject({ status: "succeeded", text: "Austin it is." });

    // The direct request is a goal of its own on the home screen.
    const goals = await (await server.fetch(new Request("http://127.0.0.1/api/goal-views"))).json();
    expect(goals.goals.map((goal: { title: string }) => goal.title)).toContain("Find a venue.");

    // The CEO was idle, so it hears about both messages at the start of its next turn, once.
    await server.runtime.sendMessage({ text: "Any news?" });
    await server.runtime.cascade.drain();
    await server.runtime.sendMessage({ text: "And now?" });
    await server.runtime.cascade.drain();
    expect(ceoPrompts[0]).toContain("## The owner spoke to your team directly");
    expect(ceoPrompts[0]).toContain(
      'VP of Research (vp-research) directly with a new request: "Find a venue."',
    );
    expect(ceoPrompts[0]).toContain("Focus on Austin.");
    expect(ceoPrompts[1]).not.toContain("The owner spoke to your team directly");
  });

  it("refuses a message to an agent that does not exist", async () => {
    const server = await openServer(async () => "ok");
    const response = await server.fetch(
      new Request("http://127.0.0.1/api/agents/nobody/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello?" }),
      }),
    );
    expect(response.status).toBe(400);
  });
});
