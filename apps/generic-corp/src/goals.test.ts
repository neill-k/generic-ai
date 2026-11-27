import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type {
  AgentTaskExecutionInput,
  AgentTaskExecutor,
  ImpossibilityReviewInput,
} from "@generic-ai/plugin-delegation";
import type { GoalJudge } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { CompanyConfig } from "./company.js";
import { createCompanyHandInCheck, measureDeliverables, resolveDeliverablePath } from "./goals.js";
import { createModelImpossibilityReviewer, secondOpinionModel } from "./second-opinion.js";
import { createGenericCorpServer, type GenericCorpServer } from "./server.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-goals-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("host-measured deliverable metrics (decision 11)", () => {
  it("counts table rows, list items, sections, words, lines and distinct links", () => {
    const plan = [
      "# Plan",
      "",
      "## Tasks",
      "",
      "| Date | Task | Owner |",
      "| --- | --- | --- |",
      "| 1 May | Draft | Ana |",
      "| 2 May | Review | Ben |",
      "",
      "## Risks",
      "",
      "- Late copy: ship a shorter issue",
      "1. Low signups: post twice",
      "",
      "See https://example.com/a and https://example.com/a and https://example.com/b.",
    ].join("\n");
    const metrics = measureDeliverables([plan, "| not | a table |"], 2);
    expect(metrics).toMatchObject({
      deliverableCount: 2,
      deliverableTableRows: 2,
      deliverableListItems: 2,
      deliverableSections: 2,
      deliverableLinks: 2,
    });
    expect(metrics["deliverableLines"]).toBe(11);
    expect(metrics["deliverableWords"]).toBeGreaterThan(30);
  });
});

describe("deliverable paths", () => {
  it("resolves from the company root first, then the agent's home, and never outside", async () => {
    const root = tempDir();
    const home = path.join(root, "agents", "analyst");
    mkdirSync(path.join(home, "workspace"), { recursive: true });
    mkdirSync(path.join(root, "drive"), { recursive: true });
    writeFileSync(path.join(home, "workspace", "brief.md"), "# Brief");
    writeFileSync(path.join(root, "drive", "shared.md"), "# Shared");
    const outside = tempDir();
    writeFileSync(path.join(outside, "secret.md"), "secret");
    symlinkSync(path.join(outside, "secret.md"), path.join(root, "drive", "link.md"));

    expect(await resolveDeliverablePath(root, home, "drive/shared.md")).toMatch(/shared\.md$/);
    expect(await resolveDeliverablePath(root, home, "agents/analyst/workspace/brief.md")).toMatch(
      /brief\.md$/,
    );
    expect(await resolveDeliverablePath(root, home, "workspace/brief.md")).toMatch(/brief\.md$/);
    expect(await resolveDeliverablePath(root, home, "drive/link.md")).toBeUndefined();
    expect(
      await resolveDeliverablePath(root, home, path.join(outside, "secret.md")),
    ).toBeUndefined();
    expect(await resolveDeliverablePath(root, home, "../secret.md")).toBeUndefined();
    expect(await resolveDeliverablePath(root, home, "drive")).toBeUndefined();

    const check = createCompanyHandInCheck({ companyRoot: root });
    expect(
      await check({ agent: { homePath: home }, deliverables: [{ path: "workspace/brief.md" }] }),
    ).toBeUndefined();
    expect(
      await check({ agent: { homePath: home }, deliverables: [{ path: "workspace/nope.md" }] }),
    ).toMatch(/no file at "workspace\/nope\.md"/);
  });
});

describe("second opinions on another model (decisions 10 and 12)", () => {
  const company: CompanyConfig = {
    name: "Test Co",
    models: { ceo: "anthropic/opus", vp: "anthropic/sonnet", ic: "anthropic/sonnet" },
    agents: [{ id: "ceo", role: "ceo" }],
  };

  it("never picks the worker's own model while another is available", () => {
    expect(secondOpinionModel(company, "anthropic/opus")).toBe("anthropic/sonnet");
    expect(secondOpinionModel(company, "anthropic/sonnet")).toBe("anthropic/opus");
    expect(secondOpinionModel({ ...company, judgeModels: ["openai/gpt"] }, "anthropic/opus")).toBe(
      "openai/gpt",
    );
    expect(
      secondOpinionModel({ ...company, judgeModels: ["anthropic/opus"] }, "anthropic/opus"),
    ).toBe("anthropic/sonnet");
  });

  it("asks the reviewer model for a verdict with written reasoning", async () => {
    const provider: FauxProviderRegistration = registerFauxProvider({
      models: [{ id: "reviewer" }],
    });
    cleanups.push(() => provider.unregister());
    const resolveModel = (): Model => provider.getModel("reviewer") as Model;
    const seen: string[] = [];
    provider.setResponses([
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage([
          fauxText(
            '```json\n{"impossible": true, "reasoning": "Moving the earth to the sun breaks physics."}\n```',
          ),
        ]);
      },
      () => fauxAssistantMessage([fauxText("I think it can be done.")]),
    ]);
    const modelFor: string[] = [];
    const reviewer = createModelImpossibilityReviewer({
      modelFor: (agent) => {
        modelFor.push(agent.id);
        return "faux/reviewer";
      },
      resolveModel,
    });
    const input = {
      task: { instruction: "Teleport the earth to the sun." },
      agent: { id: "ceo", role: "ceo", homePath: "/tmp" },
      reason: "It contradicts physics.",
      signal: new AbortController().signal,
    } as unknown as ImpossibilityReviewInput;

    await expect(reviewer(input)).resolves.toEqual({
      impossible: true,
      reasoning: "Moving the earth to the sun breaks physics.",
      reviewer: "faux/reviewer",
    });
    expect(modelFor).toEqual(["ceo"]);
    expect(seen[0]).toContain("Teleport the earth to the sun.");
    expect(seen[0]).toContain("It contradicts physics.");
    // A reply that is not the verdict is an error, so the claim is not confirmed.
    await expect(reviewer(input)).rejects.toThrow(/JSON/);
  });
});

describe("goal API: owner edits and questions", () => {
  async function startServer(executor: AgentTaskExecutor): Promise<GenericCorpServer> {
    const passAll: GoalJudge = (request) => ({
      criteria: request.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: 1,
        rationale: "Met.",
      })),
    });
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
      company: { name: "Test Co", agents: [{ id: "ceo", role: "ceo" }] },
      executor,
      goals: { judges: passAll },
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    cleanups.push(() => server.stop());
    return server;
  }

  it("lets the owner change the definition of done and answer questions without blocking", async () => {
    const prompts: string[] = [];
    let turn = 0;
    const server = await startServer(async (input: AgentTaskExecutionInput) => {
      turn += 1;
      prompts.push(input.prompt);
      const use = (name: string, params: Record<string, unknown>) => {
        const tool = input.tools?.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          throw new Error(`no ${name} tool`);
        }
        return tool.execute(params as never, { toolCallId: `${name}-${turn}` });
      };
      if (turn === 1) {
        await use("set_goal", {
          objective: "Name a product.",
          definitionOfDone: ["One name is handed in."],
          validators: [
            {
              id: "handed-in",
              kind: "output_schema",
              schema: { type: "object", required: ["summary"] },
            },
          ],
        });
        // The question is written down; the agent keeps going on its assumption.
        await use("ask_owner", {
          question: "Should the name be one word?",
          assumption: "One word.",
        });
      }
      await use("submit_work", {
        summary: turn === 1 ? "Nimbus" : "Nimbus Cloud",
        deliverables: [],
      });
      return { status: "succeeded", outputText: "Handed in." };
    });
    const call = async <T>(url: string, init?: RequestInit) => {
      const response = await server.fetch(new Request(`http://local${url}`, init));
      return { status: response.status, body: (await response.json()) as T };
    };

    const created = await call<{ taskId: string }>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ text: "Name our product" }),
    });
    const { taskId } = created.body;
    await server.runtime.cascade.drain();
    expect((await server.runtime.cascade.get(taskId))?.status).toBe("succeeded");

    const goal = await call<{ revision: number; objective: string; drafting: boolean }>(
      `/api/tasks/${taskId}/goal`,
    );
    expect(goal.body).toMatchObject({ revision: 1, objective: "Name a product.", drafting: false });

    const open = await call<{ questions: Array<{ id: string; question: string }> }>(
      "/api/questions",
    );
    expect(open.body.questions.map((question) => question.question)).toEqual([
      "Should the name be one word?",
    ]);
    const questionId = open.body.questions[0]?.id ?? "";

    const edited = await call<{ revision: number; definitionOfDone: string[] }>(
      `/api/tasks/${taskId}/goal`,
      {
        method: "PUT",
        body: JSON.stringify({ definitionOfDone: ["Two words.", "Mentions the cloud."] }),
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      revision: 2,
      definitionOfDone: ["Two words.", "Mentions the cloud."],
    });

    const answered = await call<{ questions: Array<{ answer?: string }> }>(
      `/api/tasks/${taskId}/questions/${questionId}/answer`,
      { method: "POST", body: JSON.stringify({ answer: "Two words is fine." }) },
    );
    expect(answered.body.questions[0]?.answer).toBe("Two words is fine.");
    expect((await call<{ questions: unknown[] }>("/api/questions")).body.questions).toEqual([]);
    expect(
      (await call<{ questions: unknown[] }>("/api/questions?all=1")).body.questions,
    ).toHaveLength(1);

    // The edit reopened the request; the agent is told what changed at its next step.
    await server.runtime.cascade.drain();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Mentions the cloud.");
    expect(prompts[1]).toContain("Two words is fine.");
    const settled = await server.runtime.cascade.get(taskId);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.handIn?.summary).toBe("Nimbus Cloud");

    expect(
      (
        await call(`/api/tasks/${taskId}/goal`, {
          method: "PUT",
          body: JSON.stringify({ definitionOfDone: [] }),
        })
      ).status,
    ).toBe(400);
  });
});
