import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { createSqliteRunStore, createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import type { AgentTaskExecutionResult, AgentTaskExecutor, CanonicalEvent } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { type CompanyConfig, createGenericCorpServer } from "./index.js";
import {
  openSpendingLimits,
  parseSpendLimit,
  periodBounds,
  SpendLimitError,
} from "./spend-limits.js";
import { createSqliteStorageContract } from "./storage.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-limits-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AGENTS = ["ceo", "vp-research"];

function usageEvent(runId: string, sequence: number, tokens: number, cost: number): CanonicalEvent {
  return {
    eventId: `${runId}:${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    name: "usage.recorded",
    origin: { namespace: "core" },
    scopeId: "scope",
    runId,
    rootSessionId: runId,
    sessionId: runId,
    data: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  } as CanonicalEvent;
}

describe("limit periods and input", () => {
  it("finds the day, the week from Monday and the month", () => {
    const thursday = new Date(2026, 10, 26, 15, 30);
    expect(periodBounds("day", thursday)).toEqual({
      start: new Date(2026, 10, 26),
      end: new Date(2026, 10, 27),
    });
    expect(periodBounds("week", thursday)).toEqual({
      start: new Date(2026, 10, 23),
      end: new Date(2026, 10, 30),
    });
    expect(periodBounds("month", thursday)).toEqual({
      start: new Date(2026, 10, 1),
      end: new Date(2026, 11, 1),
    });
    const sunday = new Date(2026, 10, 29, 23, 0);
    expect(periodBounds("week", sunday).start).toEqual(new Date(2026, 10, 23));
  });

  it("reads limits and rejects bad ones", () => {
    expect(parseSpendLimit({ period: "day", maxCostUsd: 20 })).toEqual({
      period: "day",
      maxCostUsd: 20,
    });
    expect(parseSpendLimit({ maxTokens: 1000.7 })).toEqual({ period: "month", maxTokens: 1000 });
    expect(parseSpendLimit(null)).toBeUndefined();
    expect(() => parseSpendLimit({ period: "year", maxCostUsd: 1 })).toThrow(SpendLimitError);
    expect(() => parseSpendLimit({ period: "day" })).toThrow(/maxCostUsd, maxTokens or both/);
    expect(() => parseSpendLimit({ maxCostUsd: -1 })).toThrow(/above 0/);
  });
});

describe("spending limits", () => {
  it("holds an agent once a limit is reached and releases it when the limit is raised", async () => {
    const kv = createSqliteStorageContract(createSqliteStorage({ path: ":memory:" }));
    let releases = 0;
    const limits = await openSpendingLimits({
      kv,
      agentIds: () => AGENTS,
      onRelease: () => {
        releases += 1;
      },
    });
    await limits.setCompanyLimit({ period: "day", maxCostUsd: 1 });
    await limits.setAgentLimit("vp-research", { period: "month", maxTokens: 100 });
    expect(limits.holdFor("ceo")).toBeUndefined();

    limits.record("vp-research", { costUsd: 0.1, tokens: 150 });
    expect(limits.holdFor("ceo")).toBeUndefined();
    expect(limits.holdFor("vp-research")).toMatchObject({ kind: "agent-limit" });
    expect(limits.holdFor("vp-research")?.reason).toMatch(/monthly spending limit of 100 tokens/);

    limits.record("ceo", { costUsd: 0.95, tokens: 10 });
    const hold = limits.holdFor("ceo");
    expect(hold).toMatchObject({
      kind: "company-limit",
      until: periodBounds("day", new Date()).end.toISOString(),
    });
    expect(hold?.reason).toMatch(
      /company's daily spending limit of \$1\.00 is reached \(\$1\.05 spent\)/,
    );

    const view = await limits.setCompanyLimit({ period: "day", maxCostUsd: 5 });
    expect(view.company).toMatchObject({ reached: false, spent: { costUsd: 1.05, tokens: 160 } });
    expect(view.spending["vp-research"]?.month).toEqual({ costUsd: 0.1, tokens: 150 });
    expect(limits.holdFor("ceo")).toBeUndefined();
    expect(releases).toBe(3);

    await expect(limits.setAgentLimit("nobody", undefined)).rejects.toThrow(/not found/);

    // Spending and settings outlive a restart.
    await limits.stop();
    const reopened = await openSpendingLimits({ kv, agentIds: () => AGENTS });
    expect(reopened.spent(undefined, "day")).toEqual({ costUsd: 1.05, tokens: 160 });
    expect(reopened.holdFor("vp-research")).toMatchObject({ kind: "agent-limit" });
    await reopened.setAgentLimit("vp-research", undefined);
    expect(reopened.holdFor("vp-research")).toBeUndefined();
  });

  it("counts usage from turn events once, even when a turn writes them again", async () => {
    const dir = tempDir();
    const store = createSqliteRunStore({ path: path.join(dir, "runs.sqlite") });
    cleanups.push(() => store.close());
    const kv = createSqliteStorageContract(createSqliteStorage({ path: ":memory:" }));
    const limits = await openSpendingLimits({ kv, agentIds: () => AGENTS });
    const metered = limits.meter(store);
    const untrack = limits.trackRun("run-1", "ceo");

    const now = new Date().toISOString();
    await metered.saveRun({
      runId: "run-1",
      rootScopeId: "scope",
      status: "running",
      envelope: {
        kind: "run-envelope",
        runId: "run-1",
        rootScopeId: "scope",
        rootAgentId: "ceo",
        mode: "sync",
        status: "running",
        timestamps: { createdAt: now },
        eventStream: { kind: "event-stream-reference", streamId: "run-1" },
      },
    } as never);
    await metered.appendEvents("run-1", [usageEvent("run-1", 1, 100, 0.25)]);
    await metered.appendEvents("run-1", [
      usageEvent("run-1", 1, 100, 0.25),
      usageEvent("run-1", 2, 50, 0.5),
    ]);
    untrack();
    expect(limits.spent("ceo", "day")).toEqual({ costUsd: 0.75, tokens: 150 });
    expect(await metered.lastSequence("run-1")).toBe(2);
  });
});

describe("spending limits in the server", () => {
  const COMPANY: CompanyConfig = {
    name: "Test Corp",
    agents: [
      { id: "ceo", role: "ceo", title: "CEO" },
      { id: "vp-research", role: "vp-research", reportsTo: "ceo" },
    ],
  };

  it("holds work at a reached limit and resumes it when the owner raises the limit", async () => {
    let turns = 0;
    const executor: AgentTaskExecutor = async (input): Promise<AgentTaskExecutionResult> => {
      turns += 1;
      const use = (name: string, params: Record<string, unknown>) =>
        input.tools
          ?.find((tool) => tool.name === name)
          ?.execute(params as never, {
            toolCallId: name,
          });
      await use("set_goal", {
        objective: "Answer the owner.",
        definitionOfDone: ["The answer is handed in."],
        validators: [
          {
            id: "handed-in",
            kind: "output_schema",
            schema: { type: "object", required: ["summary"] },
          },
        ],
      });
      await use("submit_work", { summary: "Done.", deliverables: [] });
      return { status: "succeeded", outputText: "Done." };
    };
    const server = await createGenericCorpServer({
      environment: {
        host: "127.0.0.1",
        port: 0,
        dataDir: tempDir(),
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
    const put = async (url: string, body: unknown) => {
      const response = await server.fetch(
        new Request(`http://127.0.0.1${url}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json() };
    };

    const set = await put("/api/agents/vp-research/limit", {
      limit: { period: "week", maxCostUsd: 2 },
    });
    expect(set.status).toBe(200);
    expect(set.body.agents["vp-research"]).toMatchObject({ reached: false });
    expect((await put("/api/limits/company", { limit: { period: "decade" } })).status).toBe(400);
    expect((await put("/api/agents/nobody/limit", { limit: null })).status).toBe(404);

    server.limits.record("vp-research", { costUsd: 2.5, tokens: 1000 });
    await server.runtime.messageAgent({ agentId: "vp-research", text: "Find a venue." });
    await server.runtime.cascade.drain();
    expect(turns).toBe(0);
    const listed = await (await server.fetch(new Request("http://127.0.0.1/api/limits"))).json();
    expect(listed.agents["vp-research"]).toMatchObject({ reached: true });

    await put("/api/agents/vp-research/limit", { limit: { period: "week", maxCostUsd: 10 } });
    await server.runtime.cascade.drain();
    expect(turns).toBe(1);
  });
});
