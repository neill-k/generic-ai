import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type { AgentTaskExecutionInput, AgentTaskExecutionResult } from "@generic-ai/sdk";
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
    { id: "analyst", role: "analyst", title: "Analyst", reportsTo: "vp-research" },
  ],
};

const GOAL = {
  objective: "Shape the team.",
  definitionOfDone: ["The team is shaped."],
  validators: [
    { id: "handed-in", kind: "output_schema", schema: { type: "object", required: ["summary"] } },
  ],
};

type Use = (
  name: string,
  params: Record<string, unknown>,
) => Promise<{ text: string; isError?: boolean }>;

async function openServer(dataDir: string, ceoTurn: (use: Use) => Promise<void>) {
  const executor = async (input: AgentTaskExecutionInput): Promise<AgentTaskExecutionResult> => {
    const use: Use = async (name, params) => {
      const tool = input.tools?.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { text: `no ${name} tool`, isError: true };
      }
      return tool.execute(params as never, { toolCallId: name });
    };
    if (input.tools?.some((tool) => tool.name === "set_goal")) {
      await use("set_goal", GOAL);
    }
    if (input.agentId === "ceo") {
      await ceoTurn(use);
    }
    await use("submit_work", { summary: "Done.", deliverables: [] });
    return { status: "succeeded", outputText: "Done." };
  };
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

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-org-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function activeIds(server: GenericCorpServer) {
  return (await server.runtime.listAgents())
    .filter((agent) => agent.status === "active")
    .map((agent) => agent.id)
    .sort();
}

describe("the CEO designs the org (decision 51)", () => {
  it("hires, changes and retires agents, and the changes survive a restart", async () => {
    const dataDir = tempDir();
    const results: Array<{ text: string; isError?: boolean }> = [];
    const server = await openServer(dataDir, async (use) => {
      results.push(
        await use("hire_agent", {
          id: "vp-sales",
          role: "vp-sales",
          title: "VP of Sales",
          reportsTo: "ceo",
          reason: "The goal needs someone to own pricing.",
        }),
      );
      results.push(await use("change_agent", { id: "analyst", reportsTo: "vp-sales" }));
      results.push(await use("retire_agent", { id: "vp-research" }));
      results.push(await use("hire_agent", { id: "loop", role: "x", reportsTo: "nobody" }));
      results.push(await use("retire_agent", { id: "ceo" }));
    });
    await server.runtime.sendMessage({ text: "Set up a sales team." });
    await server.runtime.cascade.drain();

    expect(results.slice(0, 3).map((result) => result.isError)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(results[3]).toMatchObject({ isError: true });
    expect(results[4]).toMatchObject({ isError: true, text: "The CEO cannot be retired." });
    expect(await activeIds(server)).toEqual(["analyst", "ceo", "vp-sales"]);
    expect((await server.runtime.directory.require("analyst")).reportsTo).toBe("vp-sales");

    const listed = await (
      await server.fetch(new Request("http://127.0.0.1/api/org/changes"))
    ).json();
    expect(listed.changes.map((change: { action: string }) => change.action)).toEqual([
      "retire",
      "change",
      "hire",
    ]);
    expect(listed.changes[2]).toMatchObject({
      by: "ceo",
      reason: "The goal needs someone to own pricing.",
    });

    await server.stop();
    cleanups.pop();
    const reopened = await openServer(dataDir, async () => undefined);
    expect(await activeIds(reopened)).toEqual(["analyst", "ceo", "vp-sales"]);
  });

  it("lets the owner overrule a change, and the CEO then leaves that agent alone", async () => {
    let turn = 0;
    const second: Array<{ text: string; isError?: boolean }> = [];
    const server = await openServer(tempDir(), async (use) => {
      turn += 1;
      if (turn === 1) {
        await use("retire_agent", { id: "analyst", reason: "Not needed." });
      } else {
        second.push(await use("retire_agent", { id: "analyst" }));
      }
    });
    await server.runtime.sendMessage({ text: "Trim the team." });
    await server.runtime.cascade.drain();
    expect(await activeIds(server)).toEqual(["ceo", "vp-research"]);

    const [retired] = await server.runtime.org.changes();
    const response = await server.fetch(
      new Request(`http://127.0.0.1/api/org/changes/${retired?.id}/overrule`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(await activeIds(server)).toEqual(["analyst", "ceo", "vp-research"]);
    const again = await server.fetch(
      new Request(`http://127.0.0.1/api/org/changes/${retired?.id}/overrule`, { method: "POST" }),
    );
    expect(again.status).toBe(409);

    await server.runtime.sendMessage({ text: "Trim the team again." });
    await server.runtime.cascade.drain();
    expect(second[0]?.isError).toBe(true);
    expect(second[0]?.text).toContain("The owner set analyst");
    expect(await activeIds(server)).toEqual(["analyst", "ceo", "vp-research"]);
  });
});
