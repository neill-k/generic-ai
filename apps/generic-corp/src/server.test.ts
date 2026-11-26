import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type {
  AgentTaskExecutionInput,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
  CanonicalEvent,
  RunStoreContract,
} from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ChatThreadView,
  type CompanyConfig,
  type CompanyCosts,
  createGenericCorpServer,
  type GenericCorpEnvironment,
  type GenericCorpServer,
  type OrgChartNode,
  type TaskSummary,
} from "./index.js";

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
    { id: "vp-research", role: "vp-research", reportsTo: "ceo" },
    { id: "researcher", role: "researcher", reportsTo: "vp-research" },
  ],
};

function json(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

function environment(overrides: Partial<GenericCorpEnvironment> = {}): GenericCorpEnvironment {
  const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    trustProxyHeaders: false,
    insecureNoAuth: true,
    workers: false,
    ...overrides,
  };
}

function usageEvent(runId: string, tokens: number, cost: number): CanonicalEvent {
  return {
    eventId: `${runId}:usage`,
    sequence: 1,
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

/**
 * A scripted company: the CEO delegates to the VP, the VP to the researcher,
 * and results come back up. Each turn records a harness run with usage so
 * costs have something to count.
 */
function scriptedCompany(getRunStore: () => RunStoreContract) {
  const calls: AgentTaskExecutionInput[] = [];
  const turns = new Map<string, number>();
  const executor: AgentTaskExecutor = async (input): Promise<AgentTaskExecutionResult> => {
    calls.push(input);
    const turn = (turns.get(input.taskId) ?? 0) + 1;
    turns.set(input.taskId, turn);
    const store = getRunStore();
    const now = new Date().toISOString();
    await store.saveRun({
      envelope: {
        kind: "run-envelope",
        runId: input.attemptRunId,
        rootScopeId: `task/${input.rootTaskId}`,
        rootAgentId: input.agentId,
        mode: "sync",
        status: "succeeded",
        timestamps: { createdAt: now, startedAt: now, completedAt: now },
        eventStream: { kind: "event-stream-reference", streamId: input.attemptRunId },
      },
      metadata: {
        kind: "agent-harness-run",
        agentId: input.agentId,
        input: { taskId: input.taskId, rootTaskId: input.rootTaskId },
      },
    });
    await store.appendEvents(input.attemptRunId, [usageEvent(input.attemptRunId, 100, 0.01)]);
    const runIds = [input.attemptRunId];

    if (input.agentId === "ceo") {
      return turn === 1
        ? {
            status: "succeeded",
            outputText: json({ delegate_task: [{ to: "vp-research", task: "Find the answer" }] }),
            runIds,
          }
        : { status: "succeeded", outputText: "The answer is 42.", runIds };
    }
    if (input.agentId === "vp-research") {
      return turn === 1
        ? {
            status: "succeeded",
            outputText: json({ delegate_task: [{ to: "researcher", task: "Look it up" }] }),
            runIds,
          }
        : { status: "succeeded", outputText: "Research says 42.", runIds };
    }
    return { status: "succeeded", outputText: "42", runIds };
  };
  return { executor, calls };
}

async function openServer(
  overrides: Partial<GenericCorpEnvironment> = {},
): Promise<{ server: GenericCorpServer; calls: AgentTaskExecutionInput[] }> {
  let server: GenericCorpServer | undefined;
  const scripted = scriptedCompany(() => (server as GenericCorpServer).storage.runStore);
  server = await createGenericCorpServer({
    environment: environment(overrides),
    company: COMPANY,
    executor: scripted.executor,
    authStore: createMemoryAuthStore(),
    log: () => undefined,
  });
  const opened = server;
  cleanups.push(() => opened.stop());
  return { server, calls: scripted.calls };
}

async function api<T = Record<string, unknown>>(
  server: GenericCorpServer,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await server.fetch(new Request(`http://127.0.0.1${pathname}`, init));
  return { status: response.status, body: (await response.json()) as T };
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

describe("Generic Corp server", () => {
  it("seeds the company and serves the org chart with per-tier models", async () => {
    const { server } = await openServer();
    const company = await api(server, "/api/company");
    expect(company.body).toMatchObject({ name: "Test Corp", ceoId: "ceo", storage: "sqlite" });

    const chart = await api<{ root: OrgChartNode }>(server, "/api/org-chart");
    expect(chart.body.root.id).toBe("ceo");
    expect(chart.body.root.tier).toBe("ceo");
    expect(chart.body.root.model).toBe("anthropic/claude-opus-5-5");
    expect(chart.body.root.reports[0]?.id).toBe("vp-research");
    expect(chart.body.root.reports[0]?.model).toBe("anthropic/claude-sonnet-5-5");
    expect(chart.body.root.reports[0]?.reports[0]).toMatchObject({ id: "researcher", tier: "ic" });

    const ready = await server.fetch(new Request("http://127.0.0.1/ready"));
    expect(ready.status).toBe(200);
  });

  it("runs an owner message through the delegation cascade and answers in the thread", async () => {
    const { server, calls } = await openServer();
    const created = await api<{ thread: ChatThreadView; taskId: string }>(
      server,
      "/api/threads",
      post({ text: "What is the answer?" }),
    );
    expect(created.status).toBe(201);
    const threadId = created.body.thread.threadId;
    expect(created.body.thread.title).toBe("What is the answer?");
    expect(created.body.thread.exchanges[0]?.reply.status).toBe("queued");

    await server.runtime.cascade.drain();

    const thread = await api<{ thread: ChatThreadView }>(server, `/api/threads/${threadId}`);
    const reply = thread.body.thread.exchanges[0]?.reply;
    expect(reply).toMatchObject({ agentId: "ceo", status: "succeeded", text: "The answer is 42." });
    expect(calls.map((call) => call.agentId)).toEqual([
      "ceo",
      "vp-research",
      "researcher",
      "vp-research",
      "ceo",
    ]);
    // The owner is recorded on every task in the cascade.
    expect(calls.every((call) => call.actor?.subjectId === "owner")).toBe(true);

    const tree = await api<{ tasks: TaskSummary[] }>(
      server,
      `/api/tasks/${created.body.taskId}/tree`,
    );
    expect(tree.body.tasks.map((task) => task.agentId)).toEqual([
      "ceo",
      "vp-research",
      "researcher",
    ]);

    const board = await api<{ columns: Array<{ status: string; tasks: unknown[] }> }>(
      server,
      "/api/board",
    );
    const done = board.body.columns.find((column) => column.status === "succeeded");
    expect(done?.tasks).toHaveLength(3);

    const roots = await api<{ tasks: unknown[] }>(server, "/api/tasks?root=1");
    expect(roots.body.tasks).toHaveLength(1);

    const costs = await api<CompanyCosts>(server, "/api/costs");
    expect(costs.body.totals.totalTokens).toBe(500);
    expect(costs.body.completedRequests).toBe(1);
    expect(costs.body.tokensPerCompletedRequest).toBe(500);
    expect(costs.body.byAgent.map((row) => row.key).sort()).toEqual([
      "ceo",
      "researcher",
      "vp-research",
    ]);

    const agent = await api<{ managementChain: string[]; tasks: TaskSummary[] }>(
      server,
      "/api/agents/researcher",
    );
    expect(agent.body.managementChain).toEqual(["vp-research", "ceo"]);
    expect(agent.body.tasks).toHaveLength(1);
  });

  it("gives the CEO the earlier exchanges of a thread", async () => {
    const { server, calls } = await openServer();
    const first = await api<{ thread: { threadId: string } }>(
      server,
      "/api/threads",
      post({ text: "First question" }),
    );
    await server.runtime.cascade.drain();
    await api(
      server,
      `/api/threads/${first.body.thread.threadId}/messages`,
      post({ text: "And then?" }),
    );
    await server.runtime.cascade.drain();
    const lastCeoTurn = calls.filter((call) => call.agentId === "ceo").at(-2);
    expect(lastCeoTurn?.prompt).toContain("Owner: First question");
    expect(lastCeoTurn?.prompt).toContain("The answer is 42.");
    expect(lastCeoTurn?.prompt).toContain("And then?");
  });

  it("cancels a request and everything it delegated", async () => {
    const { server } = await openServer();
    const created = await api<{ taskId: string }>(server, "/api/threads", post({ text: "Go" }));
    const cancelled = await api<{ cancelled: boolean; task: TaskSummary }>(
      server,
      `/api/tasks/${created.body.taskId}/cancel`,
      post({}),
    );
    expect(cancelled.body.cancelled).toBe(true);
    expect(cancelled.body.task.status).toBe("cancelled");
  });

  it("validates input", async () => {
    const { server } = await openServer();
    expect((await api(server, "/api/threads", post({ text: "  " }))).status).toBe(400);
    expect((await api(server, "/api/threads/nope/messages", post({ text: "hi" }))).status).toBe(
      404,
    );
    expect((await api(server, "/api/tasks?status=bogus")).status).toBe(400);
    expect((await api(server, "/api/agents/nobody")).status).toBe(404);
    expect((await api(server, "/api/tasks/nope")).status).toBe(404);
  });

  it("streams live events over SSE", async () => {
    const { server } = await openServer();
    const controller = new AbortController();
    const response = await server.fetch(
      new Request("http://127.0.0.1/api/events", { signal: controller.signal }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    await api(server, "/api/threads", post({ text: "Hello" }));
    while (!text.includes("event: thread.updated")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain("event: task.submitted");
    expect(text).toContain("event: thread.updated");
    controller.abort();
    await reader.cancel();
  });

  it("requires an owner credential when auth is on", async () => {
    const token = "a-static-owner-token-for-tests";
    const { server } = await openServer({ insecureNoAuth: false, authToken: token });
    expect((await api(server, "/api/company")).status).toBe(401);
    const authed = await api(server, "/api/company", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
    // Health stays public for load balancers.
    expect((await server.fetch(new Request("http://127.0.0.1/health"))).status).toBe(200);
    // The owner login page is mounted.
    expect((await server.fetch(new Request("http://127.0.0.1/auth/login"))).status).toBe(200);
  });

  it("refuses to turn auth off on a public interface", async () => {
    const { loadGenericCorpEnvironment } = await import("./server.js");
    expect(() =>
      loadGenericCorpEnvironment({
        GENERIC_CORP_HOST: "0.0.0.0",
        GENERIC_CORP_INSECURE_NO_AUTH: "1",
      }),
    ).toThrow(/loopback/);
  });
});
