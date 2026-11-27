import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { runGoalEvalSuite, type StorageContract, type StorageRecord } from "@generic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BaselineReport, RunBaselineOptions } from "./baseline.js";
import { type CheckupRun, createCompanyCheckup } from "./checkup.js";
import { main } from "./checkup-cli.js";
import { EXIT_LIVE_IN_CI, EXIT_MISSING_KEY } from "./evals-cli.js";
import type { CompanyModelAuth, ModelAuthSource } from "./model-auth.js";
import { createGenericCorpServer } from "./server.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function memoryKv(): StorageContract {
  const records = new Map<string, StorageRecord>();
  const id = (key: StorageRecord["key"]) => `${key.namespace}/${key.collection}/${key.id}`;
  return {
    kind: "storage",
    driver: "test",
    get: <T>(key: StorageRecord["key"]) => records.get(id(key)) as StorageRecord<T> | undefined,
    set: (record) => {
      records.set(id(record.key), record as StorageRecord);
    },
    delete: (key) => records.delete(id(key)),
    list: (filter) =>
      [...records.values()].filter(
        (record) =>
          (filter?.namespace === undefined || record.key.namespace === filter.namespace) &&
          (filter?.collection === undefined || record.key.collection === filter.collection),
      ),
    clear: () => records.clear(),
  };
}

function modelAuth(source: ModelAuthSource = "subscription"): CompanyModelAuth {
  const status = async () => ({ provider: "anthropic" as const, source });
  return {
    getAuth: async () => undefined,
    status,
    startClaudeSignIn: async () => ({ flowId: "f", url: "https://example.test" }),
    finishClaudeSignIn: status,
    saveApiKey: status,
    signOut: status,
  };
}

/** A baseline runner that never calls a model: it reports fixed numbers. */
function fakeRunner(calls: RunBaselineOptions[] = []) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = async (options: RunBaselineOptions): Promise<BaselineReport> => {
    calls.push(options);
    const plan = options.plan;
    if (plan === undefined) {
      throw new Error("The checkup always passes a plan.");
    }
    const configs = [];
    for (const config of plan.configs) {
      options.onConfigStart?.(config);
      await gate;
      const totalTokens = config.features.delegation ? 20_000 : 100_000;
      const result = {
        id: config.id,
        label: config.label,
        features: config.features,
        attempts: 1,
        passed: 1,
        notRun: 0,
        totalTokens,
        tokensPerFinishedGoal: totalTokens,
        costUsd: null,
        attemptsWithoutUsage: 0,
        reductionVsSingleAgent: config.features.delegation ? 0.8 : null,
        report: await runGoalEvalSuite({
          suite: { kind: "generic-ai.goal-eval-suite", id: config.id, cases: [] },
          execute: async () => {
            throw new Error("No cases to run.");
          },
        }),
      };
      options.onConfigDone?.(result);
      configs.push(result);
    }
    return {
      kind: "generic-ai.baseline-report",
      generatedAt: "2026-11-27T00:00:00.000Z",
      templateId: plan.templateId,
      caseIds: plan.caseIds,
      trials: plan.trials,
      set: plan.set,
      configs,
      headline: "Generic Corp used 80% fewer tokens per finished goal than a plain single agent.",
      spent: { tokens: 120_000, costUsd: 0, responses: 12 },
      maxTokens: options.spendCap?.limits.maxTokens ?? 0,
    };
  };
  return { run, release: () => release() };
}

describe("checkup service", () => {
  it("shows the plan and expected usage, runs one checkup at a time, and keeps the report", async () => {
    const calls: RunBaselineOptions[] = [];
    const runner = fakeRunner(calls);
    const checkup = createCompanyCheckup({
      kv: memoryKv(),
      modelAuth: modelAuth(),
      run: runner.run,
    });

    const view = await checkup.plan();
    expect(view.ready).toBe(true);
    expect(view.estimate.basis).toBe("guess");
    expect(view.description).toMatch(/Expected usage: .* tokens/);

    const run = await checkup.start({ startedBy: "owner" });
    expect(run).toMatchObject({ status: "running", startedBy: "owner", finished: [] });
    expect(run.plan.configs.map((config) => config.id)).toEqual(["single-agent", "company"]);
    // The run is capped at the estimate the owner saw.
    expect(calls[0]?.spendCap?.limits.maxTokens).toBe(view.estimate.maxTokens);

    await expect(checkup.start()).rejects.toMatchObject({ status: 409 });
    expect((await checkup.plan()).reason).toBe("A checkup is already running.");

    runner.release();
    await checkup.idle();
    const done = (await checkup.get(run.id)) as CheckupRun;
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("succeeded");
    expect(done.headline).toMatch(/80% fewer tokens/);
    expect(done.finished.map((result) => result.id)).toEqual(["single-agent", "company"]);
    expect(done.markdown).toContain("| Plain single agent | 1/1 |");
    expect(done.running).toBeUndefined();

    // The next estimate uses what this checkup really used.
    const next = await checkup.plan();
    expect(next.estimate.basis).toBe("measured");
    expect(next.estimate.highTokens).toBe(180_000);
  });

  it("will not start without a model sign-in", async () => {
    const checkup = createCompanyCheckup({
      kv: memoryKv(),
      modelAuth: modelAuth("none"),
      run: fakeRunner().run,
    });
    expect((await checkup.plan()).reason).toMatch(/no model sign-in/);
    await expect(checkup.start()).rejects.toMatchObject({ status: 409 });
  });

  it("records a failed checkup, and one cut off by a restart", async () => {
    const kv = memoryKv();
    const checkup = createCompanyCheckup({
      kv,
      modelAuth: modelAuth(),
      run: async () => {
        throw new Error("model unavailable");
      },
    });
    const run = await checkup.start();
    await checkup.idle();
    expect(await checkup.get(run.id)).toMatchObject({
      status: "failed",
      error: "model unavailable",
    });

    const runner = fakeRunner();
    const first = createCompanyCheckup({ kv, modelAuth: modelAuth(), run: runner.run });
    const interrupted = await first.start();
    // A new process over the same storage sees the run as cut off, and can start another.
    const second = createCompanyCheckup({ kv, modelAuth: modelAuth(), run: fakeRunner().run });
    expect(await second.get(interrupted.id)).toMatchObject({
      status: "failed",
      error: "The server stopped while this checkup was running.",
    });
    expect((await second.plan()).ready).toBe(true);
    runner.release();
    await first.idle();
  });
});

describe("checkup API", () => {
  it("shows the plan, requires confirmation, and starts the checkup in the background", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-checkup-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const runner = fakeRunner();
    const checkup = createCompanyCheckup({
      kv: memoryKv(),
      modelAuth: modelAuth(),
      run: runner.run,
    });
    const server = await createGenericCorpServer({
      environment: {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        trustProxyHeaders: false,
        insecureNoAuth: true,
        workers: false,
      },
      env: {},
      checkup,
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    cleanups.push(() => server.stop());
    const call = async (pathname: string, init: RequestInit = {}) => {
      const response = await server.fetch(new Request(`http://127.0.0.1/api${pathname}`, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const post = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const shown = await call("/checkup?set=ablation");
    expect(shown.status).toBe(200);
    expect(shown.body["ready"]).toBe(true);
    expect((shown.body["plan"] as { configs: unknown[] }).configs).toHaveLength(6);
    expect(shown.body["latest"]).toBeUndefined();
    expect((await call("/checkup?set=everything")).status).toBe(400);

    const unconfirmed = await call("/checkup", post({}));
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body["error"]).toMatch(/confirm/);
    expect(unconfirmed.body["description"]).toMatch(/Expected usage/);

    const started = await call("/checkup", post({ confirm: true }));
    expect(started.status).toBe(202);
    expect(started.body["status"]).toBe("running");
    expect((await call("/checkup", post({ confirm: true }))).status).toBe(409);

    runner.release();
    await checkup.idle();
    const id = String(started.body["id"]);
    const fetched = await call(`/checkups/${id}`);
    expect(fetched.body).toMatchObject({ status: "succeeded" });
    expect(fetched.body["report"]).toBeDefined();
    const listed = await call("/checkups");
    const runs = listed.body["checkups"] as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ id, status: "succeeded" });
    expect(runs[0]?.["report"]).toBeUndefined();
    expect((await call("/checkup")).body["latest"]).toMatchObject({ id });
    expect((await call("/checkups/nope")).status).toBe(404);
  });
});

describe("checkup command", () => {
  const quiet = () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      out.push(message);
    });
    vi.spyOn(console, "error").mockImplementation((message: string) => {
      out.push(message);
    });
    return out;
  };

  it("shows the plan and expected usage without running", async () => {
    const out = quiet();
    expect(await main(["--plan", "--set", "ablation"], { env: {} })).toBe(0);
    expect(out.join("\n")).toMatch(/on 6 configuration\(s\)[\s\S]*Expected usage/);
  });

  it("refuses to run in GitHub Actions", async () => {
    quiet();
    expect(
      await main(["--yes"], { env: { GITHUB_ACTIONS: "true", ANTHROPIC_API_KEY: "set" } }),
    ).toBe(EXIT_LIVE_IN_CI);
  });

  it("exits before running when agents have no model sign-in", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-checkup-cli-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const out = quiet();
    expect(await main(["--yes", "--data-dir", dataDir], { env: {} })).toBe(EXIT_MISSING_KEY);
    expect(out.join("\n")).toMatch(/Nothing was run/);
  });

  it("does not start unless confirmed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-checkup-cli-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const out = quiet();
    const env = { ANTHROPIC_API_KEY: "set" };
    expect(await main(["--data-dir", dataDir], { env, confirm: async () => false })).toBe(2);
    expect(out.join("\n")).toMatch(/Not started/);
    expect(await main(["--set", "all"], { env })).toBe(2);
    expect(await main(["--trials", "0"], { env })).toBe(2);
  });
});
