import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteRunStore } from "@generic-ai/plugin-storage-sqlite";
import {
  type AgentHarnessAdapterRunContext,
  type AgentHarnessRunInput,
  type CanonicalEvent,
  createMockRuntimeAdapter,
} from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAdapterTaskExecutor,
  normalizeRunEvents,
  resolveAgentRoleKind,
  routeTaskExecutor,
  withRunPersistence,
} from "../src/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function openStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "gai-persist-"));
  const store = createSqliteRunStore({ path: path.join(directory, "state.db") });
  cleanups.push(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

const context: AgentHarnessAdapterRunContext = {
  events: { emit: () => undefined },
  artifacts: { write: async () => ({ id: "a", kind: "custom", uri: "memory://a" }) },
  policy: { evaluate: async () => ({ allowed: true, decision: {} as never }) },
};

function event(runId: string, sequence: number): CanonicalEvent {
  return {
    eventId: `e-${sequence}`,
    sequence,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    name: "session.started",
    origin: { namespace: "core" },
    scopeId: "scope",
    runId,
    rootSessionId: "root",
    sessionId: "root",
    data: {},
  };
}

describe("withRunPersistence", () => {
  it("records each harness run, its events, and its session in the run store", async () => {
    const store = openStore();
    const base = createMockRuntimeAdapter();
    const adapter = withRunPersistence(
      {
        ...base,
        run: async (input, runContext) => {
          const result = await base.run(input, runContext);
          return {
            ...result,
            outputText: "hello",
            envelope: { ...result.envelope, runId: input.runId ?? "x" },
            events: [event("other-run", 4), event("other-run", 9)],
          };
        },
      },
      store,
    );
    const result = await adapter.run(
      {
        instruction: "Say hello",
        harness: { id: "h" },
        workspaceRoot: "/tmp",
        runId: "run-1",
        rootAgentId: "ceo",
      },
      context,
    );
    expect(result.outputText).toBe("hello");

    const run = await store.getRun("run-1");
    expect(run?.envelope.status).toBe("succeeded");
    expect(run?.metadata?.["agentId"]).toBe("ceo");
    expect(run?.metadata?.["outputText"]).toBe("hello");
    const events = await store.readEvents("run-1");
    expect(events.map((item) => [item.runId, item.sequence])).toEqual([
      ["run-1", 1],
      ["run-1", 2],
    ]);
    const sessions = await store.listSessions("run-1");
    expect(sessions[0]?.status).toBe("succeeded");
    expect(sessions[0]?.agentId).toBe("ceo");
  });

  it("marks the run failed when the adapter throws", async () => {
    const store = openStore();
    const adapter = withRunPersistence(
      createMockRuntimeAdapter({
        run: () => {
          throw new Error("boom");
        },
      }),
      store,
    );
    await expect(
      adapter.run(
        { instruction: "x", harness: { id: "h" }, workspaceRoot: "/tmp", runId: "r" },
        context,
      ),
    ).rejects.toThrow("boom");
    const run = await store.getRun("r");
    expect(run?.envelope.status).toBe("failed");
    expect(run?.metadata?.["failureMessage"]).toBe("boom");
  });

  it("keeps ordered events for the same run unchanged", () => {
    const events = [event("r", 2), event("r", 5)];
    expect(normalizeRunEvents("r", events)).toEqual(events);
  });
});

describe("createAdapterTaskExecutor", () => {
  it("runs each agent turn as a single-role harness with the agent's model", async () => {
    const seen: AgentHarnessRunInput[] = [];
    const executor = createAdapterTaskExecutor({
      adapter: createMockRuntimeAdapter({
        run: async (input, runContext) => {
          seen.push(input);
          const fallback = await createMockRuntimeAdapter().run(input, runContext);
          return { ...fallback, outputText: "turn output" };
        },
      }),
      harness: { id: "company", model: "openai/gpt-5.5" },
      context,
      turnTimeoutMs: 60_000,
    });
    const result = await executor({
      taskId: "t1",
      attemptRunId: "t1:turn-0:attempt-1",
      rootTaskId: "t1",
      agentId: "ceo",
      role: "ceo",
      roleKind: "planner",
      model: "anthropic/claude-opus",
      instructions: "Run the company.",
      prompt: "Do the thing",
      workspaceRoot: "/agents/ceo",
    });
    expect(result).toMatchObject({ status: "succeeded", outputText: "turn output" });
    const input = seen[0];
    expect(input?.runId).toBe("t1:turn-0:attempt-1");
    expect(input?.workspaceRoot).toBe("/agents/ceo");
    expect(input?.harness.model).toBe("anthropic/claude-opus");
    expect(input?.harness.primaryAgent).toBe("ceo");
    expect(input?.harness.roles).toEqual([
      expect.objectContaining({
        id: "ceo",
        kind: "planner",
        readOnly: true,
        instructions: "Run the company.",
      }),
    ]);
    expect(input?.deadline).toBeDefined();
  });

  it("maps role kinds and routes executors per turn", async () => {
    expect(resolveAgentRoleKind("verifier")).toBe("verifier");
    expect(resolveAgentRoleKind("root")).toBe("builder");
    expect(resolveAgentRoleKind("something-else", "explorer")).toBe("explorer");
    const routed = routeTaskExecutor(
      (input) =>
        input.agentId === "ceo"
          ? () => ({ status: "succeeded", outputText: "topology" })
          : undefined,
      () => ({ status: "succeeded", outputText: "single" }),
    );
    const base = {
      taskId: "t",
      attemptRunId: "a",
      rootTaskId: "t",
      role: "r",
      prompt: "p",
      workspaceRoot: "/w",
    };
    expect((await routed({ ...base, agentId: "ceo" })).outputText).toBe("topology");
    expect((await routed({ ...base, agentId: "ic" })).outputText).toBe("single");
  });
});
