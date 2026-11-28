import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import type { AgentTaskExecutionResult, AgentTaskExecutor } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { type CompanyConfig, createGenericCorpServer } from "./index.js";
import type { CompanyModelAuth, ModelAuthSource } from "./model-auth.js";
import { createPlanLimit, PLAN_RESET_REASON, readPlanLimitError } from "./plan-limit.js";
import { createSqliteStorageContract } from "./storage.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const LIMIT_ERROR =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Claude AI usage limit reached|1764252000"}}';
const failed = (failureMessage: string): AgentTaskExecutionResult => ({
  status: "failed",
  outputText: "",
  failureMessage,
});

function kv() {
  return createSqliteStorageContract(createSqliteStorage({ path: ":memory:" }));
}

describe("reading plan limit errors", () => {
  it("finds the limit and its reset time", () => {
    expect(readPlanLimitError(LIMIT_ERROR)).toEqual(new Date(1764252000 * 1000));
    expect(readPlanLimitError("rate_limit_error: slow down")).toBeNull();
    expect(readPlanLimitError("Overloaded (529)")).toBeUndefined();
    expect(readPlanLimitError("request id 14299 failed")).toBeUndefined();
    expect(readPlanLimitError(undefined)).toBeUndefined();
  });
});

describe("plan limit", () => {
  it("waits for the reset by default, backing off when the reset time is unknown", async () => {
    let clock = Date.parse("2026-11-27T10:00:00Z");
    const releases: number[] = [];
    const plan = await createPlanLimit({
      kv: kv(),
      source: async () => "subscription",
      apiKey: async () => undefined,
      now: () => new Date(clock),
      onRelease: () => releases.push(clock),
    });
    const turn = { model: "anthropic/claude-opus-5-5" };

    expect(await plan.observe(turn, failed("Overloaded"))).toBe(false);
    expect(await plan.observe({ model: "openai/gpt-6" }, failed("429"))).toBe(false);
    expect(await plan.observe(turn, failed("rate_limit_error"))).toBe(true);
    expect(await plan.holdFor("ceo")).toEqual({
      kind: "plan-reset",
      reason: PLAN_RESET_REASON,
      until: "2026-11-27T10:15:00.000Z",
    });
    expect(await plan.status()).toMatchObject({
      behaviour: "wait",
      limited: true,
      resetKnown: false,
      usingApiKey: false,
    });

    // Still limited on the next try: the wait doubles.
    clock = Date.parse("2026-11-27T10:16:00Z");
    expect(await plan.holdFor("ceo")).toBeUndefined();
    expect(await plan.observe(turn, failed("rate_limit_error"))).toBe(true);
    expect((await plan.holdFor("ceo"))?.until).toBe("2026-11-27T10:46:00.000Z");

    // A known reset time wins.
    expect(await plan.observe(turn, failed(LIMIT_ERROR.replace("1764252000", "1796000000")))).toBe(
      true,
    );
    expect((await plan.holdFor("ceo"))?.until).toBe(new Date(1796000000 * 1000).toISOString());
  });

  it("uses the API key while the plan is limited when the owner chose that", async () => {
    let key: string | undefined;
    let releases = 0;
    const plan = await createPlanLimit({
      kv: kv(),
      source: async () => "subscription",
      apiKey: async () => key,
      onRelease: () => {
        releases += 1;
      },
    });
    const signIn = async () => ({ apiKey: "oauth-token" });
    const turn = { model: "anthropic/claude-opus-5-5" };

    await plan.setBehaviour("api_key");
    expect(await plan.observe(turn, failed("rate_limit_error"))).toBe(true);
    // No key yet: it waits like the default.
    expect(await plan.holdFor("ceo")).toMatchObject({ kind: "plan-reset" });
    expect(await plan.getAuth("anthropic", signIn)).toEqual({ apiKey: "oauth-token" });

    key = "sk-ant-fallback";
    expect(await plan.holdFor("ceo")).toBeUndefined();
    expect(await plan.getAuth("anthropic", signIn)).toEqual({ apiKey: "sk-ant-fallback" });
    expect(await plan.getAuth("openai", signIn)).toEqual({ apiKey: "oauth-token" });
    expect(await plan.status()).toMatchObject({ limited: true, usingApiKey: true });

    // Going back to waiting holds work again.
    await plan.setBehaviour("wait");
    expect(await plan.holdFor("ceo")).toMatchObject({ kind: "plan-reset" });
    expect(await plan.getAuth("anthropic", signIn)).toEqual({ apiKey: "oauth-token" });
    expect(releases).toBe(2);
  });

  it("ignores rate limits when agents run on an API key", async () => {
    const plan = await createPlanLimit({
      kv: kv(),
      source: async () => "api_key",
      apiKey: async () => undefined,
    });
    expect(await plan.observe({ model: "anthropic/x" }, failed("rate_limit_error"))).toBe(false);
    expect(await plan.holdFor("ceo")).toBeUndefined();
  });
});

describe("plan limit in the server", () => {
  const COMPANY: CompanyConfig = {
    name: "Test Corp",
    agents: [{ id: "ceo", role: "ceo", title: "CEO" }],
  };
  const GOAL = {
    objective: "Answer the owner.",
    definitionOfDone: ["The answer is handed in."],
    validators: [
      { id: "handed-in", kind: "output_schema", schema: { type: "object", required: ["summary"] } },
    ],
  };

  function fakeModelAuth(): CompanyModelAuth {
    const status = async () => ({
      provider: "anthropic" as const,
      // The plan sign-in is removed; this simulates the dormant plan-limit path.
      source: "subscription" as string as ModelAuthSource,
    });
    return {
      getAuth: async () => ({ apiKey: "oauth-token" }),
      status,
      saveApiKey: status,
      signOut: status,
    };
  }

  async function openServer(executor: AgentTaskExecutor, env: NodeJS.ProcessEnv = {}) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-plan-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await createGenericCorpServer({
      env,
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
      modelAuth: fakeModelAuth(),
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    cleanups.push(() => server.stop());
    return server;
  }

  const succeed = async (input: Parameters<AgentTaskExecutor>[0]) => {
    const use = (name: string, params: Record<string, unknown>) =>
      input.tools
        ?.find((tool) => tool.name === name)
        ?.execute(params as never, {
          toolCallId: name,
        });
    await use("set_goal", GOAL);
    await use("submit_work", { summary: "Done.", deliverables: [] });
    return { status: "succeeded" as const, outputText: "Done." };
  };

  it("parks a turn that hit the plan's limit instead of failing it", async () => {
    let turns = 0;
    const server = await openServer(async (input) => {
      turns += 1;
      return turns === 1 ? failed(LIMIT_ERROR.replace("1764252000", "4102444800")) : succeed(input);
    });
    await server.runtime.messageAgent({ agentId: "ceo", text: "Plan a trip." });
    await server.runtime.cascade.drain();
    expect(turns).toBe(1);
    const task = (await server.runtime.listTasks({ agentId: "ceo" }))[0];
    expect(task?.hold).toMatchObject({ kind: "plan-reset", reason: PLAN_RESET_REASON });
    expect(task?.status).not.toBe("failed");

    const settings = await (
      await server.fetch(new Request("http://127.0.0.1/api/settings/plan-limit"))
    ).json();
    expect(settings).toMatchObject({ behaviour: "wait", limited: true, resetKnown: true });
  });

  it("runs the turn again on the API key when the owner chose that", async () => {
    const auths: unknown[] = [];
    let turns = 0;
    const server = await openServer(
      async (input) => {
        turns += 1;
        return turns === 1 ? failed("rate_limit_error") : succeed(input);
      },
      { ANTHROPIC_API_KEY: "sk-ant-fallback" },
    );
    const response = await server.fetch(
      new Request("http://127.0.0.1/api/settings/plan-limit", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behaviour: "api_key" }),
      }),
    );
    expect(await response.json()).toMatchObject({ behaviour: "api_key", apiKeyAvailable: true });
    const bad = await server.fetch(
      new Request("http://127.0.0.1/api/settings/plan-limit", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behaviour: "panic" }),
      }),
    );
    expect(bad.status).toBe(400);

    await server.runtime.messageAgent({ agentId: "ceo", text: "Plan a trip." });
    await server.runtime.cascade.drain();
    expect(turns).toBe(2);
    expect((await server.runtime.listTasks({ agentId: "ceo" }))[0]?.status).toBe("succeeded");
    auths.push(await server.runtime.holds.holdFor("ceo"));
    expect(auths).toEqual([undefined]);
  });
});
