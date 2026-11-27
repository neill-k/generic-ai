import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type { AgentTaskExecutionResult, AgentTaskExecutor } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { COMPANY_PAUSE_REASON } from "./holds.js";
import { type CompanyConfig, createGenericCorpServer } from "./index.js";

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

async function openServer(executor: AgentTaskExecutor) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-pause-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await createGenericCorpServer({
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
  cleanups.push(() => server.stop());
  return server;
}

function put(server: Awaited<ReturnType<typeof openServer>>, url: string, paused: boolean) {
  return server.fetch(
    new Request(`http://127.0.0.1${url}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused }),
    }),
  );
}

describe("pause (decision 33)", () => {
  it("holds work while the company is paused and resumes it when work resumes", async () => {
    let turns = 0;
    const server = await openServer(async (input): Promise<AgentTaskExecutionResult> => {
      turns += 1;
      const use = (name: string, params: Record<string, unknown>) =>
        input.tools
          ?.find((tool) => tool.name === name)
          ?.execute(params as never, { toolCallId: name });
      await use("set_goal", GOAL);
      await use("submit_work", { summary: "Done.", deliverables: [] });
      return { status: "succeeded", outputText: "Done." };
    });

    const paused = await (await put(server, "/api/pause", true)).json();
    expect(paused.company).toBe(true);
    expect(typeof paused.since).toBe("string");

    await server.runtime.messageAgent({ agentId: "vp-research", text: "Find a venue." });
    await server.runtime.cascade.drain();
    expect(turns).toBe(0);

    const goals = await (await server.fetch(new Request("http://127.0.0.1/api/goal-views"))).json();
    expect(goals.goals[0]).toMatchObject({ state: "paused", statusText: COMPANY_PAUSE_REASON });

    const resumed = await (await put(server, "/api/pause", false)).json();
    expect(resumed.company).toBe(false);
    await server.runtime.cascade.drain();
    expect(turns).toBe(1);
  });

  it("pauses one agent without holding the others", async () => {
    const server = await openServer(() => ({ status: "succeeded", outputText: "ok" }));
    const state = await (await put(server, "/api/agents/vp-research/pause", true)).json();
    expect(state).toMatchObject({ company: false, agents: ["vp-research"] });
    expect(await server.runtime.holds.holdFor("vp-research")).toMatchObject({
      kind: "owner-pause",
    });
    expect(await server.runtime.holds.holdFor("ceo")).toBeUndefined();

    const after = await (await put(server, "/api/agents/vp-research/pause", false)).json();
    expect(after.agents).toEqual([]);
  });
});
