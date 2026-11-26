import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { runGoalEvalSuite } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { CompanyConfigError, DEFAULT_COMPANY, parseCompanyConfig } from "./company.js";
import { createCompanyEvalExecutor, runTemplateEvals, type TemplateReplay } from "./evals.js";
import { createGenericCorpServer, loadCompany } from "./server.js";
import {
  DEFAULT_TEMPLATE,
  listCompanyTemplates,
  loadCompanyTemplate,
  loadTemplateEvalSuite,
} from "./templates.js";
import { createCompanyToolkit } from "./toolkit.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-templates-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const TEMPLATES = listCompanyTemplates();

describe("company templates", () => {
  it("ships the default company and templates for non-software work", () => {
    expect(TEMPLATES[0]).toBe(DEFAULT_TEMPLATE);
    expect(TEMPLATES).toEqual(expect.arrayContaining(["research-desk", "back-office"]));
  });

  it("keeps the generic-corp template's org chart in step with the built-in default", async () => {
    const template = await loadCompanyTemplate(DEFAULT_TEMPLATE);
    expect(template.name).toBe(DEFAULT_COMPANY.name);
    expect(template.mission).toBe(DEFAULT_COMPANY.mission);
    expect(template.agents).toEqual(DEFAULT_COMPANY.agents);
  });

  it.each(
    TEMPLATES,
  )("%s: every goal has an eval case with a replay, and the suite gates on reliability", async (templateId) => {
    const { company, suite, replays } = await loadTemplateEvalSuite(templateId);
    expect(company.template).toBe(templateId);
    const goals = company.goals ?? [];
    expect(goals.length).toBeGreaterThanOrEqual(1);
    const evaluated = new Set(suite.cases.map((testCase) => testCase.goal.id));
    for (const goal of goals) {
      expect(evaluated, `goal ${goal.id} has no eval case`).toContain(goal.id);
      // Every goal checks NOVA's three things: a number, a rubric, and the actions taken.
      const kinds = new Set(goal.spec.validators.map((validator) => validator.kind));
      expect([...kinds]).toEqual(expect.arrayContaining(["numeric", "rubric", "trace"]));
    }
    for (const testCase of suite.cases) {
      expect(replays[testCase.id], `case ${testCase.id} has no replay`).toBeDefined();
    }
    expect(suite.gate?.minPassK).toBeGreaterThan(0);
    expect(suite.trials?.passK).toBeGreaterThanOrEqual(2);
  });

  // The CI gate: each template's goals replay end to end through the org chart, the cascade,
  // the real tools and the goal validators, and the suite's gate must pass.
  it.each(TEMPLATES)("%s: replayed goal evals pass the gate", async (templateId) => {
    const { report, markdown } = await runTemplateEvals({
      templateId,
      mode: "replay",
      trials: 1,
    });
    expect(report.gate.reasons, markdown).toEqual([]);
    expect(report.gate.passed).toBe(true);
    for (const result of report.results) {
      expect(result.failedValidators, `${result.caseId}: ${result.failureMessage ?? ""}`).toEqual(
        [],
      );
      expect(result.integrity).toEqual([]);
      expect(result.usage?.totalTokens).toBeGreaterThan(0);
    }
  }, 60_000);

  it("fails the gate when the team skips the research its goal requires", async () => {
    const { company, suite, replays } = await loadTemplateEvalSuite("research-desk");
    const original = parseYaml(
      await readFile(replays["market-brief"] as string, "utf8"),
    ) as TemplateReplay;
    // The analyst writes the brief without searching or opening a single page.
    const lazy: TemplateReplay = {
      ...original,
      agents: {
        ...original.agents,
        analyst: (original.agents["analyst"] ?? []).filter(
          (step) => step.call !== "web_search" && step.call !== "web_fetch",
        ),
      },
    };
    const file = path.join(tempDir(), "lazy.yaml");
    await writeFile(file, stringifyYaml(lazy));
    const report = await runGoalEvalSuite({
      suite: { ...suite, trials: { count: 1, passK: 1 } },
      execute: createCompanyEvalExecutor({
        company,
        mode: "replay",
        replays: { "market-brief": file },
      }),
      judges: () => original.judgments?.["quality"] ?? { criteria: [] },
    });
    expect(report.gate.passed).toBe(false);
    const [result] = report.results;
    expect(result?.failedValidators).toContain("researched");
  }, 60_000);

  it("gives every agent the standup, review and compound-learning skills", async () => {
    const toolkit = createCompanyToolkit({ company: DEFAULT_COMPANY, env: {} });
    cleanups.push(() => toolkit.close());
    expect(toolkit.describe().skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["standup", "review", "compound-learning"]),
    );
  });

  it("starts the company from GENERIC_CORP_TEMPLATE, and rejects unknown templates", async () => {
    const base = {
      host: "127.0.0.1",
      port: 0,
      dataDir: tempDir(),
      trustProxyHeaders: false,
      insecureNoAuth: true,
      workers: false,
    };
    expect((await loadCompany({ ...base, template: "back-office" })).name).toBe("Back Office");
    expect((await loadCompany(base)).template).toBe(DEFAULT_TEMPLATE);
    await expect(loadCompany({ ...base, template: "moon-base" })).rejects.toThrow(
      /no company template "moon-base"/,
    );
  });

  it("rejects company goals that cannot be checked", () => {
    const agents = [{ id: "ceo", role: "ceo" }];
    expect(() =>
      parseCompanyConfig({
        agents,
        goals: [{ id: "g", request: "Do it.", goal: { objective: "x", definitionOfDone: [] } }],
      }),
    ).toThrow(CompanyConfigError);
    expect(() =>
      parseCompanyConfig({
        agents,
        goals: [
          {
            id: "g",
            goal: {
              objective: "x",
              definitionOfDone: ["y"],
              validators: [{ id: "v", kind: "trace", require: [{ tool: "write" }] }],
            },
          },
        ],
      }),
    ).toThrow(/request/);
  });
});

describe("starting from a company goal", () => {
  it("lists the company's goals and attaches the chosen one to the CEO's task", async () => {
    const company = await loadCompanyTemplate("back-office");
    const server = await createGenericCorpServer({
      environment: {
        host: "127.0.0.1",
        port: 0,
        dataDir: tempDir(),
        trustProxyHeaders: false,
        insecureNoAuth: true,
        workers: false,
      },
      env: {},
      company,
      executor: async () => ({ status: "succeeded", outputText: "ok", runIds: [] }),
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    cleanups.push(() => server.stop());

    const listed = await server.fetch(new Request("http://127.0.0.1/api/goals"));
    const { template, goals } = (await listed.json()) as {
      template: string;
      goals: Array<{ id: string; request: string; checks: Array<{ kind: string }> }>;
    };
    expect(template).toBe("back-office");
    expect(goals.map((goal) => goal.id)).toEqual(["month-end-close", "support-replies"]);
    expect(goals[0]?.checks.map((check) => check.kind)).toContain("numeric");

    const started = await server.fetch(
      new Request("http://127.0.0.1/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: "month-end-close" }),
      }),
    );
    expect(started.status).toBe(201);
    const { taskId, thread } = (await started.json()) as {
      taskId: string;
      thread: { exchanges: Array<{ message: { text: string } }> };
    };
    expect(thread.exchanges[0]?.message.text).toContain("Close March's expenses");
    const task = await server.runtime.cascade.get(taskId);
    expect(task?.goal?.spec?.id).toBe("month-end-close");
    expect(task?.goal?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const unknown = await server.fetch(
      new Request("http://127.0.0.1/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi", goalId: "world-peace" }),
      }),
    );
    expect(unknown.status).toBe(404);
  });
});
