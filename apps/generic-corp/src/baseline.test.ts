import {
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import type { GoalEvalSuiteSpec, GoalJudge } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_CONFIGS,
  type BaselineReport,
  baselineCompany,
  baselinePlan,
  COMPANY_CONFIG,
  describeBaselineEstimate,
  estimateBaseline,
  explainModelError,
  GUESSED_TOKENS_PER_ATTEMPT,
  renderBaselineMarkdown,
  runBaseline,
  SINGLE_AGENT_CONFIG,
} from "./baseline.js";
import type { CompanyConfig } from "./company.js";
import { checkPython } from "./rlm.js";
import { createSpendCap } from "./spend.js";
import { loadCompanyTemplate, type TemplateEvalSuite } from "./templates.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const COMPANY: CompanyConfig = {
  name: "Baseline Test",
  models: { ceo: "faux/lead", vp: "faux/judge", ic: "faux/worker" },
  agents: [
    {
      id: "lead",
      role: "lead",
      title: "Lead",
      instructions: "Run the team. Send writing to the Writer.",
    },
    {
      id: "writer",
      role: "writer",
      title: "Writer",
      reportsTo: "lead",
      instructions: "Write notes in plain words.",
    },
  ],
};

const SUITE: GoalEvalSuiteSpec = {
  kind: "generic-ai.goal-eval-suite",
  id: "baseline-test",
  cases: [
    {
      id: "note",
      goal: {
        id: "note",
        objective: "A short note for the owner, written down and handed in.",
        definitionOfDone: ["A note is written to a file and handed in."],
        validators: [
          {
            id: "handed-in",
            kind: "output_schema",
            schema: { type: "object", required: ["summary"] },
          },
          { id: "written", kind: "trace", require: [{ tool: "write" }] },
        ],
      },
    },
  ],
};

const TEMPLATE: TemplateEvalSuite = {
  templateId: "baseline-test",
  company: COMPANY,
  suite: SUITE,
  replays: {},
};

function text(message: Context["messages"][number]): string {
  if (message.role === "toolResult") {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

const AGENT_IN_TASK = /\(agent id "([A-Za-z0-9._-]+)", role /;

/**
 * A scripted model that plays every agent. A lead with a team delegates the note and hands in
 * what comes back; anyone working alone writes it and hands it in. Each request is recorded so
 * the test can see which tools and prompt each configuration gave the agents.
 */
function scriptedModel(options: { readonly firstCommand?: string } = {}): {
  resolveModel: (ref: string) => Model;
  requests: Context[];
} {
  const requests: Context[] = [];
  const provider = registerFauxProvider({ models: [{ id: "scripted" }] });
  cleanups.push(() => provider.unregister());
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const respond = (context: Context) => {
    requests.push(context);
    const first = context.messages[0];
    const agentId = (first === undefined ? undefined : AGENT_IN_TASK.exec(text(first))?.[1]) ?? "";
    const last = context.messages.at(-1);
    const lastTool = last?.role === "toolResult" ? last.toolName : undefined;
    if (lastTool === "submit_work" || lastTool === "delegate_task") {
      return call("stop_and_respond", { response: "Done for now." });
    }
    const prompt = [...context.messages].reverse().find((message) => message.role === "user");
    const works =
      agentId !== "lead" ||
      (prompt !== undefined && text(prompt).includes("nobody to delegate to"));
    if (!works) {
      return prompt !== undefined && text(prompt).includes("## Results from the work you delegated")
        ? call("submit_work", { summary: "The writer's note is ready.", deliverables: [] })
        : call("delegate_task", { tasks: [{ to: "writer", task: "Write the note." }] });
    }
    if (options.firstCommand !== undefined && lastTool === undefined) {
      return call("bash", { command: options.firstCommand });
    }
    if (lastTool === "write") {
      return call("submit_work", { summary: "Wrote the note.", deliverables: [] });
    }
    return call("write", { path: "workspace/note.md", content: "A short note for the owner." });
  };
  provider.setResponses(Array.from({ length: 400 }, () => respond));
  const model = provider.getModel("scripted");
  if (model === undefined) {
    throw new Error("The scripted model could not be registered.");
  }
  return { resolveModel: () => model, requests };
}

const passingJudge: GoalJudge = () => ({ summary: "fine", criteria: [] });

/** The task prompt the cascade wrote for this request. */
function promptOf(context: Context): string {
  const first = context.messages[0];
  return first === undefined ? "" : text(first);
}

function toolNames(context: Context): readonly string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

describe("baseline comparison", () => {
  it("runs the plain single agent and the full company on the same goal and compares tokens per finished goal", async () => {
    const { resolveModel, requests } = scriptedModel();
    const started: string[] = [];
    const report = await runBaseline({
      plan: { ...baselinePlan({ set: "core" }), templateId: "baseline-test", caseIds: ["note"] },
      template: TEMPLATE,
      env: {},
      resolveModel,
      judge: passingJudge,
      onConfigStart: (config) => started.push(config.id),
      log: () => undefined,
      now: () => new Date("2026-11-27T00:00:00Z"),
    });

    expect(started).toEqual([SINGLE_AGENT_CONFIG.id, COMPANY_CONFIG.id]);
    const [single, company] = report.configs;
    expect(single).toMatchObject({ id: "single-agent", attempts: 1, passed: 1, notRun: 0 });
    expect(company).toMatchObject({ id: "company", attempts: 1, passed: 1, notRun: 0 });
    // The scripted model reports estimated usage, so every configuration has real numbers.
    expect(single?.totalTokens).toBeGreaterThan(0);
    expect(company?.totalTokens).toBeGreaterThan(0);
    expect(single?.tokensPerFinishedGoal).toBe(single?.totalTokens);
    expect(single?.reductionVsSingleAgent).toBeNull();
    const expected =
      1 - (company?.tokensPerFinishedGoal ?? 0) / (single?.tokensPerFinishedGoal ?? 1);
    expect(company?.reductionVsSingleAgent).toBeCloseTo(expected, 10);
    expect(report.headline).toMatch(
      /tokens per finished goal than a plain single agent \(NOVA claims 90%\)/,
    );
    expect(report.spent.tokens).toBeGreaterThanOrEqual(
      (single?.totalTokens ?? 0) + (company?.totalTokens ?? 0),
    );

    // The single agent works alone; the company's lead delegates to the writer.
    const leadRequests = requests.filter((context) =>
      promptOf(context).includes('(agent id "lead"'),
    );
    const singleRequests = leadRequests.filter((context) =>
      promptOf(context).includes("nobody to delegate to"),
    );
    const companyRequests = leadRequests.filter((context) =>
      promptOf(context).includes('"writer": Writer'),
    );
    expect(singleRequests.length).toBeGreaterThan(0);
    expect(companyRequests.length).toBeGreaterThan(0);
    expect(requests.some((context) => promptOf(context).includes('(agent id "writer"'))).toBe(true);

    // Memory and the Python workspace are off for the single agent, on for the company.
    for (const context of singleRequests) {
      expect(promptOf(context)).not.toContain("## Your memory");
      expect(toolNames(context)).not.toContain("python");
      expect(toolNames(context)).not.toContain("remember");
    }
    for (const context of companyRequests) {
      expect(promptOf(context)).toContain("## Your memory");
      expect(toolNames(context)).toContain("remember");
      // The Python workspace is on whenever this host can run Python 3.
      if (checkPython("python3") === undefined) {
        expect(toolNames(context)).toContain("python");
      }
    }

    const markdown = renderBaselineMarkdown(report);
    expect(markdown).toContain("| Plain single agent | 1/1 |");
    expect(markdown).toContain("| Generic Corp, everything on | 1/1 |");
    expect(markdown).toContain("baseline");
  }, 60_000);

  it("gives the attempts' agent commands the shared egress proxy when one is passed", async () => {
    const { resolveModel, requests } = scriptedModel({ firstCommand: "printenv HTTPS_PROXY" });
    const shared: string[] = [];
    await runBaseline({
      plan: {
        ...baselinePlan({ set: "core" }),
        templateId: "baseline-test",
        caseIds: ["note"],
        configs: [SINGLE_AGENT_CONFIG],
      },
      template: TEMPLATE,
      env: {},
      resolveModel,
      judge: passingJudge,
      egressProxy: {
        envFor: (agentId) => {
          shared.push(agentId);
          return { HTTPS_PROXY: `http://127.0.0.1:9/${agentId}`, HTTP_PROXY: "http://127.0.0.1:9" };
        },
      },
      log: () => undefined,
    });
    expect(shared).toContain("lead");
    const output = requests
      .flatMap((context) => context.messages)
      .filter((message) => message.role === "toolResult" && message.toolName === "bash")
      .flatMap((message) => (message.role === "toolResult" ? message.content : []))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(output).toContain("http://127.0.0.1:9/lead");
  }, 60_000);

  it("stops at the token cap and counts attempts not run as unfinished", async () => {
    const { resolveModel } = scriptedModel();
    const report = await runBaseline({
      plan: { ...baselinePlan({ set: "core" }), templateId: "baseline-test", caseIds: ["note"] },
      template: TEMPLATE,
      env: {},
      resolveModel,
      judge: passingJudge,
      spendCap: createSpendCap({ maxTokens: 1 }),
      log: () => undefined,
    });
    expect(report.capReason).toMatch(/spend cap was reached/);
    const company = report.configs.find((result) => result.id === "company");
    expect(company?.notRun).toBe(1);
    expect(company?.passed).toBe(0);
    expect(report.headline).toMatch(/Generic Corp finished no goals/);
  }, 60_000);

  it("makes the single agent one agent that does every role's part itself", async () => {
    const template = await loadCompanyTemplate("back-office");
    const single = baselineCompany(template, SINGLE_AGENT_CONFIG.features);
    expect(single.agents).toHaveLength(1);
    const [agent] = single.agents;
    expect(agent?.id).toBe("manager");
    expect(agent?.reportsTo).toBeUndefined();
    expect(agent?.instructions).toMatch(/^You work alone/);
    // The bookkeeper's know-how comes along, so only the structure changes.
    expect(agent?.instructions).toContain("Compute totals with a script");
    expect(agent?.secrets).toContain("ACCOUNTING_*");
    expect(baselineCompany(template, COMPANY_CONFIG.features)).toBe(template);
  });

  it("shows the plan and the expected usage before anything runs", () => {
    const plan = baselinePlan();
    expect(plan).toMatchObject({
      templateId: "back-office",
      caseIds: ["month-end-close"],
      trials: 1,
      set: "core",
    });
    const estimate = estimateBaseline(plan);
    expect(estimate.basis).toBe("guess");
    expect(estimate.attempts).toBe(2);
    expect(estimate.lowTokens).toBe(
      GUESSED_TOKENS_PER_ATTEMPT.single.low + GUESSED_TOKENS_PER_ATTEMPT.team.low,
    );
    expect(estimate.maxTokens).toBe(estimate.highTokens);
    expect(describeBaselineEstimate(plan, estimate)).toMatch(
      /month-end-close from the back-office template, 1 attempt\(s\) each, on 2 configuration\(s\).*\n.*a guess until the first checkup has run/,
    );

    const ablation = baselinePlan({ set: "ablation" });
    expect(ablation.configs.map((config) => config.id)).toEqual(
      BASELINE_CONFIGS.map((config) => config.id),
    );
    expect(ablation.configs.map((config) => config.id)).toEqual([
      "single-agent",
      "company",
      "company-no-delegation",
      "company-no-offload",
      "company-no-rlm",
      "company-no-memory",
    ]);

    // After a run, the estimate uses what each configuration really used.
    const previous = {
      configs: [
        { id: "single-agent", attempts: 1, notRun: 0, totalTokens: 100_000 },
        { id: "company", attempts: 1, notRun: 0, totalTokens: 40_000 },
      ],
    } as unknown as Pick<BaselineReport, "configs">;
    const measured = estimateBaseline(plan, previous);
    expect(measured.basis).toBe("measured");
    expect(measured.lowTokens).toBe(70_000);
    expect(measured.highTokens).toBe(210_000);
  });

  it("explains a model error in plain words", () => {
    const extra =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}';
    expect(explainModelError(extra)).toMatch(
      /^Claude refused every model call: it billed them as extra usage/,
    );
    expect(explainModelError(extra)).toContain("More > Claude sign-in");
    expect(explainModelError("429 rate_limit_error")).toMatch(/usage or rate limit/);
    expect(explainModelError("401 authentication_error")).toMatch(/rejected the sign-in/);
    expect(explainModelError("socket hang up")).toBe(
      "Model calls failed, so no goal could finish. The error was: socket hang up",
    );
  });
});
