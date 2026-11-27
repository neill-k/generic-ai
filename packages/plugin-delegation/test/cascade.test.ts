import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSqliteQueue,
  createSqliteRunStore,
  type SqliteQueue,
} from "@generic-ai/plugin-storage-sqlite";
import {
  type AgentTaskExecutionInput,
  type AgentTaskExecutionResult,
  type AgentTaskExecutor,
  createToolEffectGuard,
  type RunStoreContract,
  type ToolEffectJournal,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { createManualClock, type ManualClock } from "@generic-ai/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AgentDirectory,
  type AgentTaskJobPayload,
  type AgentTaskJobResult,
  type CreateDelegationCascadeOptions,
  createAgentDirectory,
  createDelegationCascade,
  createMemoryAgentStore,
  type DelegationCascade,
  type DelegationCascadeEvent,
  listToolEffectRecords,
  type PersistentAgentSeed,
  readDirectives,
  turnCheckpointSessionId,
} from "../src/index.js";

const ORG: readonly PersistentAgentSeed[] = [
  {
    id: "ceo",
    role: "ceo",
    title: "Chief Executive",
    roleKind: "planner",
    model: "anthropic/opus",
  },
  { id: "vp-research", role: "vp", title: "VP Research", reportsTo: "ceo" },
  { id: "vp-ops", role: "vp", title: "VP Operations", reportsTo: "ceo" },
  { id: "analyst", role: "ic", title: "Analyst", reportsTo: "vp-research" },
];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function json(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

type Script = (input: AgentTaskExecutionInput, turn: number) => AgentTaskExecutionResult;

/** Scripted executor: one function per agent, called with that agent's turn count. */
function scriptedExecutor(scripts: Record<string, Script>) {
  const calls: AgentTaskExecutionInput[] = [];
  const turns = new Map<string, number>();
  const executor: AgentTaskExecutor = (input) => {
    calls.push(input);
    const turn = (turns.get(input.taskId) ?? 0) + 1;
    turns.set(input.taskId, turn);
    const script = scripts[input.agentId];
    if (script === undefined) {
      return { status: "succeeded", outputText: `${input.agentId} did: ${input.taskId}` };
    }
    return script(input, turn);
  };
  return { executor, calls };
}

interface Harness {
  readonly file: string;
  readonly root: string;
  readonly clock: ManualClock;
  readonly runStore: RunStoreContract & { close(): Promise<void> | void };
  readonly queue: SqliteQueue<AgentTaskJobPayload, AgentTaskJobResult>;
  readonly directory: AgentDirectory;
  readonly cascade: DelegationCascade;
}

async function openHarness(
  executor: AgentTaskExecutor,
  overrides: Partial<CreateDelegationCascadeOptions> & {
    readonly file?: string;
    readonly root?: string;
    readonly clock?: ManualClock;
    readonly agentStore?: ReturnType<typeof createMemoryAgentStore>;
    readonly seed?: boolean;
  } = {},
): Promise<Harness> {
  const base = overrides.file === undefined ? tempDir("gai-cascade-") : undefined;
  const file = overrides.file ?? path.join(base as string, "state.db");
  const root = overrides.root ?? path.join(path.dirname(file), "agents");
  const clock = overrides.clock ?? createManualClock();
  const runStore = createSqliteRunStore({ path: file, now: clock.now });
  const queue = createSqliteQueue<AgentTaskJobPayload, AgentTaskJobResult>({
    path: file,
    now: clock.now,
    maxAttempts: 2,
    leaseMs: 60_000,
    backoff: { baseMs: 0, maxMs: 0 },
  });
  const directory = createAgentDirectory({
    store: overrides.agentStore ?? createMemoryAgentStore(),
    root,
    now: () => new Date(clock.now()),
  });
  if (overrides.seed !== false) {
    await directory.seed(ORG);
  }
  const cascade = createDelegationCascade({
    runStore,
    queue,
    directory,
    executor,
    now: () => new Date(clock.now()),
    // These scenarios predate the submit_work hand-in (ADR 0069); the hand-in tests opt in.
    handIn: "reply",
    ...overrides,
  });
  const harness = { file, root, clock, runStore, queue, directory, cascade };
  cleanups.push(async () => {
    await cascade.stop();
    await queue.close?.();
    await runStore.close();
  });
  return harness;
}

describe("agent directory (R8)", () => {
  it("seeds an org chart with persistent memory and workspaces", async () => {
    const root = tempDir("gai-agents-");
    const store = createMemoryAgentStore();
    const directory = createAgentDirectory({ store, root });
    const seeded = await directory.seed(ORG);
    expect(seeded.created).toEqual(["ceo", "vp-research", "vp-ops", "analyst"]);

    const analyst = await directory.require("analyst");
    expect(analyst.memoryPath).toBe(path.join(root, "analyst", "context.md"));
    expect(analyst.workspacePath).toBe(path.join(root, "analyst", "workspace"));
    expect(await readFile(analyst.memoryPath, "utf8")).toContain("Analyst (analyst)");
    expect((await directory.directReports("ceo")).map((agent) => agent.id)).toEqual([
      "vp-ops",
      "vp-research",
    ]);
    expect((await directory.managementChain("analyst")).map((agent) => agent.id)).toEqual([
      "vp-research",
      "ceo",
    ]);

    await directory.appendMemory("analyst", "- Learned: prefer primary sources.");
    // A fresh directory over the same store (a restart) keeps records and memory.
    const reopened = createAgentDirectory({ store, root });
    const reseeded = await reopened.seed([...ORG.filter((agent) => agent.id !== "vp-ops")]);
    expect(reseeded.created).toEqual([]);
    expect(reseeded.retired).toEqual(["vp-ops"]);
    expect(await reopened.readMemory("analyst")).toContain("prefer primary sources");
    expect((await reopened.list()).map((agent) => agent.id)).not.toContain("vp-ops");
    expect((await reopened.list({ includeRetired: true })).map((agent) => agent.id)).toContain(
      "vp-ops",
    );
  });

  it("refreshes config fields on reseed", async () => {
    const directory = createAgentDirectory({
      store: createMemoryAgentStore(),
      root: tempDir("gai-agents-"),
    });
    await directory.seed(ORG);
    const result = await directory.seed(
      ORG.map((agent) => (agent.id === "analyst" ? { ...agent, model: "openai/gpt-5.5" } : agent)),
    );
    expect(result.updated).toEqual(["analyst"]);
    expect((await directory.require("analyst")).model).toBe("openai/gpt-5.5");
  });

  it("rejects invalid org charts", async () => {
    const directory = createAgentDirectory({
      store: createMemoryAgentStore(),
      root: tempDir("gai-agents-"),
    });
    await expect(directory.seed([{ id: "../x", role: "ic" }])).rejects.toThrow(/must be/);
    await expect(directory.seed([{ id: "a", role: "ic", reportsTo: "missing" }])).rejects.toThrow(
      /unknown agent/,
    );
    await expect(
      directory.seed([
        { id: "a", role: "ic", reportsTo: "b" },
        { id: "b", role: "ic", reportsTo: "a" },
      ]),
    ).rejects.toThrow(/cycle/);
  });

  it("gives each agent its own git worktree", async () => {
    const { execFileSync } = await import("node:child_process");
    const repository = tempDir("gai-repo-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const directory = createAgentDirectory({
      store: createMemoryAgentStore(),
      root: tempDir("gai-agents-"),
      workspace: { mode: "git-worktree", repository },
    });
    await directory.seed([{ id: "builder-1", role: "engineer" }]);
    const agent = await directory.require("builder-1");
    expect(git("worktree", "list")).toContain(agent.workspacePath);
    expect(git("branch", "--list", "agent/builder-1")).toContain("agent/builder-1");
  });
});

describe("delegation directives", () => {
  it("reads delegations, failures, and malformed entries", () => {
    expect(readDirectives("all done").delegations).toEqual([]);
    expect(
      readDirectives(
        `Plan:${json({ delegate_task: [{ to: "vp-ops", task: "Book venue", definitionOfDone: "Signed contract" }] })}`,
      ).delegations,
    ).toEqual([
      { to: "vp-ops", task: "Book venue", goal: { definitionOfDone: "Signed contract" } },
    ]);
    expect(
      readDirectives(json({ finish_task: { status: "failed", reason: "No budget" } })).impossible,
    ).toBe("No budget");
    expect(readDirectives(json({ declare_impossible: { reason: "No budget" } })).impossible).toBe(
      "No budget",
    );
    expect(
      readDirectives(
        json({ submit_work: { summary: "Done", deliverables: [{ path: "drive/a.md" }] } }),
      ).handIn,
    ).toEqual({ summary: "Done", deliverables: [{ path: "drive/a.md" }] });
    expect(readDirectives(json({ submit_work: { deliverables: [] } })).invalid).toMatch(/summary/);
    expect(readDirectives(json({ delegate_task: [{ to: "x" }] })).invalid).toMatch(
      /needs a string/,
    );
  });
});

describe("delegation cascade (R9)", () => {
  it("runs a multi-level cascade and bubbles results up the org chart", async () => {
    const { executor, calls } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: `Splitting the work.${json({
                delegate_task: [
                  {
                    to: "vp-research",
                    task: "Research the market",
                    definitionOfDone: "3 competitors",
                  },
                  { to: "vp-ops", task: "Draft a budget" },
                ],
              })}`,
            }
          : { status: "succeeded", outputText: "Final plan: research and budget combined." },
      "vp-research": (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: { to: "analyst", task: "List competitors" } }),
            }
          : { status: "succeeded", outputText: "Market summary from analyst work." },
      analyst: () => ({ status: "succeeded", outputText: "Competitors: A, B, C" }),
    });
    const { cascade, runStore } = await openHarness(executor);

    const root = await cascade.submit({
      agentId: "ceo",
      instruction: "Launch the product",
      taskId: "launch",
    });
    expect(root.status).toBe("queued");
    await cascade.drain();

    const done = await cascade.get("launch");
    expect(done?.status).toBe("succeeded");
    expect(done?.outputText).toBe("Final plan: research and budget combined.");
    expect(done?.childTaskIds).toEqual(["launch.0.1", "launch.0.2"]);

    const tree = await cascade.tree("launch");
    expect(tree.map((task) => [task.taskId, task.agentId, task.status, task.depth])).toEqual([
      ["launch", "ceo", "succeeded", 0],
      ["launch.0.1", "vp-research", "succeeded", 1],
      ["launch.0.2", "vp-ops", "succeeded", 1],
      ["launch.0.1.0.1", "analyst", "succeeded", 2],
    ]);
    expect(tree.find((task) => task.taskId === "launch.0.1")?.goal).toEqual({
      definitionOfDone: "3 competitors",
    });

    // The CEO's second turn sees its reports' results, and models are per role.
    const ceoTurns = calls.filter((call) => call.agentId === "ceo");
    expect(ceoTurns).toHaveLength(2);
    expect(ceoTurns[0]?.model).toBe("anthropic/opus");
    expect(ceoTurns[0]?.prompt).toContain('"vp-research": VP Research');
    expect(ceoTurns[1]?.prompt).toContain("Market summary from analyst work.");
    expect(ceoTurns[1]?.prompt).toContain("did: launch.0.2");
    const analystTurn = calls.find((call) => call.agentId === "analyst");
    expect(analystTurn?.prompt).toContain('You report to VP Research ("vp-research")');
    expect(analystTurn?.workspaceRoot).toMatch(/agents[\\/]analyst$/);

    // Every task keeps a durable event log.
    const names = (await runStore.readEvents("launch")).map((event) => event.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "run.created",
        "session.started",
        "delegation.requested",
        "delegation.completed",
        "run.completed",
      ]),
    );
  });

  it("survives a restart in the middle of a cascade", async () => {
    const { executor } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "vp-ops", task: "Hire a contractor" }] }),
            }
          : { status: "succeeded", outputText: "Contractor hired." },
    });
    const first = await openHarness(executor);
    await first.cascade.submit({ agentId: "ceo", instruction: "Get help", taskId: "help" });
    expect(await first.cascade.drain({ maxJobs: 1 })).toBe(1);
    expect((await first.cascade.get("help"))?.status).toBe("waiting");

    // A crash: the VP's turn is leased by a worker that dies without settling it.
    const orphan = await first.queue.lease({ names: [first.cascade.jobName], leaseMs: 1_000 });
    expect(orphan?.payload.taskId).toBe("help.0.1");
    await first.queue.close?.();
    await first.runStore.close();

    // A new process over the same database picks the cascade up after the lease expires.
    const agentStore = createMemoryAgentStore();
    first.clock.advance(5_000);
    const second = await openHarness(executor, {
      file: first.file,
      root: first.root,
      clock: first.clock,
      agentStore,
    });
    expect(await second.cascade.recover()).toBe(0);
    await second.cascade.drain();
    const done = await second.cascade.get("help");
    expect(done?.status).toBe("succeeded");
    expect(done?.outputText).toBe("Contractor hired.");
  });

  it("recover() re-queues work whose queue entry was lost", async () => {
    const { executor } = scriptedExecutor({});
    const harness = await openHarness(executor);
    await harness.cascade.submit({
      agentId: "vp-ops",
      instruction: "Count chairs",
      taskId: "chairs",
    });
    // Simulate a lost job by cancelling it out from under the task.
    await harness.queue.cancel(`${harness.cascade.jobName}:chairs:0`);
    expect(await harness.cascade.recover()).toBe(1);
    await harness.cascade.drain();
    expect((await harness.cascade.get("chairs"))?.status).toBe("succeeded");
  });

  it("enforces the org chart and lets the agent recover from a rejected delegation", async () => {
    const { executor, calls } = scriptedExecutor({
      "vp-ops": (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "analyst", task: "x" }] }),
            }
          : { status: "succeeded", outputText: "Did it myself." },
    });
    const { cascade } = await openHarness(executor);
    await cascade.submit({ agentId: "vp-ops", instruction: "Plan", taskId: "plan" });
    await cascade.drain();
    const task = await cascade.get("plan");
    expect(task?.status).toBe("succeeded");
    expect(task?.childTaskIds).toEqual([]);
    expect(calls[1]?.prompt).toContain('Agent "analyst" does not report to you.');
  });

  it("allows delegation anywhere in the subtree when configured", async () => {
    const { executor } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "analyst", task: "x" }] }),
            }
          : { status: "succeeded", outputText: "ok" },
    });
    const { cascade } = await openHarness(executor, { delegationScope: "subtree" });
    await cascade.submit({ agentId: "ceo", instruction: "Plan", taskId: "plan" });
    await cascade.drain();
    expect((await cascade.get("plan"))?.childTaskIds).toEqual(["plan.0.1"]);
  });

  it("leaves the memory file out of prompts when memoryFile is off", async () => {
    const { executor, calls } = scriptedExecutor({});
    const { cascade, directory } = await openHarness(executor, { memoryFile: false });
    await directory.appendMemory("analyst", "secret old note");
    await cascade.submit({ agentId: "analyst", instruction: "Write", taskId: "plain" });
    await cascade.drain();
    expect(calls[0]?.prompt).not.toContain("context.md");
    expect(calls[0]?.prompt).not.toContain("secret old note");
    expect(calls[0]?.prompt).toContain("Your workspace is");
  });

  it("keeps the task going until the validator passes", async () => {
    const { executor, calls } = scriptedExecutor({
      analyst: (_input, turn) => ({
        status: "succeeded",
        outputText: turn < 2 ? "draft" : "COMPLETE",
      }),
    });
    const { cascade } = await openHarness(executor, {
      validate: ({ outputText }) =>
        outputText.includes("COMPLETE")
          ? { passed: true }
          : { passed: false, feedback: "Output must say COMPLETE." },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Write", taskId: "write" });
    await cascade.drain();
    const task = await cascade.get("write");
    expect(task?.status).toBe("succeeded");
    expect(task?.validationFailures).toBe(1);
    expect(calls[1]?.prompt).toContain("Output must say COMPLETE.");
    expect(calls[1]?.prompt).toContain("Your previous result:\ndraft");
  });

  it("fails a task that never passes validation", async () => {
    const { executor } = scriptedExecutor({
      analyst: () => ({ status: "succeeded", outputText: "draft" }),
    });
    const { cascade } = await openHarness(executor, {
      validate: () => ({ passed: false, feedback: "nope" }),
      maxValidationAttempts: 2,
    });
    await cascade.submit({ agentId: "analyst", instruction: "Write", taskId: "write" });
    await cascade.drain();
    const task = await cascade.get("write");
    expect(task?.status).toBe("failed");
    expect(task?.failureMessage).toMatch(/failed validation 2 times/);
  });

  it("keeps a task going past any fixed number of rounds until validation passes", async () => {
    let turns = 0;
    const { executor } = scriptedExecutor({
      analyst: () => {
        turns += 1;
        return { status: "succeeded", outputText: turns >= 20 ? "COMPLETE" : "draft" };
      },
    });
    const { cascade } = await openHarness(executor, {
      validate: ({ outputText }) =>
        outputText.includes("COMPLETE") ? { passed: true } : { passed: false, feedback: "not yet" },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Write", taskId: "long" });
    await cascade.drain();
    const task = await cascade.get("long");
    expect(task?.status).toBe("succeeded");
    expect(turns).toBe(20);
    expect(task?.round).toBeGreaterThan(12);
  });

  it("retries a failed turn, then reports the failure to the parent", async () => {
    const { executor, calls } = scriptedExecutor({
      "vp-ops": (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "analyst", task: "x" }] }),
            }
          : { status: "succeeded", outputText: "Handled the analyst failure." },
      analyst: () => ({ status: "failed", outputText: "", failureMessage: "model unavailable" }),
    });
    const { cascade } = await openHarness(executor, { delegationScope: "any" });
    await cascade.submit({ agentId: "vp-ops", instruction: "Plan", taskId: "plan" });
    await cascade.drain();
    const child = await cascade.get("plan.0.1");
    expect(child?.status).toBe("failed");
    expect(child?.attempts).toBe(2);
    expect(calls.filter((call) => call.agentId === "analyst")).toHaveLength(2);
    const parent = await cascade.get("plan");
    expect(parent?.status).toBe("succeeded");
    expect(calls.at(-1)?.prompt).toContain("Failure: model unavailable");
  });

  it("does not retry non-retryable failures", async () => {
    const { executor, calls } = scriptedExecutor({
      analyst: () => ({
        status: "failed",
        outputText: "",
        failureMessage: "denied",
        retryable: false,
      }),
    });
    const { cascade } = await openHarness(executor);
    await cascade.submit({ agentId: "analyst", instruction: "x", taskId: "x" });
    await cascade.drain();
    expect((await cascade.get("x"))?.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("ends a task as impossible only when the reviewer agrees (older finish_task JSON)", async () => {
    const { executor } = scriptedExecutor({
      analyst: () => ({
        status: "succeeded",
        outputText: json({ finish_task: { status: "failed", reason: "Source is paywalled" } }),
      }),
    });
    const { cascade } = await openHarness(executor, {
      impossibility: () => ({ impossible: true, reasoning: "Agreed.", reviewer: "judge-model" }),
    });
    await cascade.submit({ agentId: "analyst", instruction: "x", taskId: "x" });
    await cascade.drain();
    const task = await cascade.get("x");
    expect(task?.status).toBe("failed");
    expect(task?.failureMessage).toBe(
      "Declared impossible: Source is paywalled\nConfirmed by judge-model: Agreed.",
    );
    expect(task?.impossible?.review?.reviewer).toBe("judge-model");
  });

  it("refuses delegation that would deadlock or go too deep", async () => {
    const { executor, calls } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "vp-ops", task: "x" }] }),
            }
          : { status: "succeeded", outputText: "done" },
      "vp-ops": (_input, turn) =>
        turn === 1
          ? { status: "succeeded", outputText: json({ delegate_task: [{ to: "ceo", task: "y" }] }) }
          : { status: "succeeded", outputText: "fine" },
    });
    const { cascade } = await openHarness(executor, { delegationScope: "any", maxDepth: 1 });
    await cascade.submit({ agentId: "ceo", instruction: "x", taskId: "x" });
    await cascade.drain();
    expect((await cascade.get("x"))?.status).toBe("succeeded");
    const vpRetry = calls.filter((call) => call.agentId === "vp-ops")[1];
    expect(vpRetry?.prompt).toContain("would deadlock");
    expect(vpRetry?.prompt).toContain("limited to 1 levels");
  });

  it("cancels a task and everything it delegated", async () => {
    const { executor } = scriptedExecutor({
      ceo: () => ({
        status: "succeeded",
        outputText: json({
          delegate_task: [
            { to: "vp-ops", task: "a" },
            { to: "vp-research", task: "b" },
          ],
        }),
      }),
    });
    const { cascade, queue } = await openHarness(executor);
    await cascade.submit({ agentId: "ceo", instruction: "x", taskId: "x" });
    await cascade.drain({ maxJobs: 1 });
    expect(await cascade.cancel("x")).toBe(true);
    expect(await cascade.cancel("x")).toBe(false);
    const tree = await cascade.tree("x");
    expect(tree.map((task) => task.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await queue.size(cascade.jobName)).toBe(0);
    expect(await cascade.drain()).toBe(0);
  });

  it("runs at most one turn per agent at a time", async () => {
    const { executor } = scriptedExecutor({});
    const { cascade, queue } = await openHarness(executor);
    await cascade.submit({ agentId: "analyst", instruction: "one", taskId: "one" });
    await cascade.submit({ agentId: "analyst", instruction: "two", taskId: "two" });
    await cascade.submit({ agentId: "vp-ops", instruction: "three", taskId: "three" });
    const first = await queue.lease({ names: [cascade.jobName] });
    const second = await queue.lease({ names: [cascade.jobName] });
    const third = await queue.lease({ names: [cascade.jobName] });
    expect(new Set([first?.payload.taskId, second?.payload.taskId])).toEqual(
      new Set(["one", "three"]),
    );
    expect(third).toBeUndefined();
  });

  it("submits idempotently and waits for results with the queue worker", async () => {
    const { executor } = scriptedExecutor({});
    const { cascade } = await openHarness(executor, {
      worker: { pollIntervalMs: 5, leaseMs: 5_000 },
    });
    const a = await cascade.submit({ agentId: "analyst", instruction: "x", taskId: "same" });
    const b = await cascade.submit({ agentId: "analyst", instruction: "x", taskId: "same" });
    expect(b.version).toBe(a.version);
    cascade.start();
    const done = await cascade.wait("same", { timeoutMs: 5_000, pollIntervalMs: 5 });
    expect(done.status).toBe("succeeded");
  });

  it("rejects work for retired or unknown agents", async () => {
    const { executor } = scriptedExecutor({});
    const { cascade } = await openHarness(executor);
    await expect(cascade.submit({ agentId: "nobody", instruction: "x" })).rejects.toThrow(
      /Unknown agent/,
    );
  });

  it("hands a long child result to the parent as a file path with an excerpt", async () => {
    const long = `${"Finding. ".repeat(2_000)}THE END`;
    const { executor, calls } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({
                delegate_task: [
                  { to: "vp-research", task: "Research everything" },
                  { to: "vp-ops", task: "Say hi" },
                ],
              }),
            }
          : { status: "succeeded", outputText: "Done." },
      "vp-research": () => ({ status: "succeeded", outputText: long }),
      "vp-ops": () => ({ status: "succeeded", outputText: "hi" }),
    });
    const saved: string[] = [];
    const { cascade } = await openHarness(executor, {
      saveChildResult: async (child) => {
        saved.push(child.taskId);
        return `drive/goals/${child.rootTaskId}/handoffs/${child.agentId}.md`;
      },
    });
    await cascade.submit({ agentId: "ceo", instruction: "Plan", taskId: "plan" });
    await cascade.drain();

    expect(saved).toEqual(["plan.0.1"]);
    const second = calls.filter((call) => call.agentId === "ceo")[1]?.prompt ?? "";
    expect(second).toContain(
      `The whole result (${long.length} characters) is in drive/goals/plan/handoffs/vp-research.md.`,
    );
    expect(second).not.toContain("THE END");
    expect(second).toContain("hi");
    expect(second.length).toBeLessThan(long.length);
  });
});

const postgresUrl = process.env["GENERIC_AI_TEST_POSTGRES_URL"];

describe.skipIf(!postgresUrl)("delegation cascade on Postgres", () => {
  it("runs one cascade across two worker processes sharing the database", async () => {
    const { openPostgresStorage, quoteIdentifier } = await import(
      "@generic-ai/plugin-storage-postgres"
    );
    const { createStorageAgentStore } = await import("../src/index.js");
    const schema = `gai_cascade_${Math.random().toString(16).slice(2, 10)}`;
    const root = tempDir("gai-pg-agents-");
    const { executor } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({
                delegate_task: [
                  { to: "vp-research", task: "Research" },
                  { to: "vp-ops", task: "Operate" },
                ],
              }),
            }
          : { status: "succeeded", outputText: "All done." },
    });

    const open = async () => {
      const storage = await openPostgresStorage({
        connectionString: postgresUrl as string,
        schema,
      });
      const directory = createAgentDirectory({
        store: createStorageAgentStore(storage.storage),
        root,
      });
      await directory.seed(ORG);
      const cascade = createDelegationCascade({
        runStore: storage.runs,
        queue: storage.queue<AgentTaskJobPayload, AgentTaskJobResult>({
          backoff: { baseMs: 0, maxMs: 0 },
        }),
        directory,
        executor,
        handIn: "reply",
        worker: { pollIntervalMs: 10, leaseMs: 10_000 },
      });
      return { storage, cascade };
    };
    const a = await open();
    const b = await open();
    cleanups.push(async () => {
      await a.cascade.stop();
      await b.cascade.stop();
      await a.storage.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await a.storage.close();
      await b.storage.close();
    });

    await a.cascade.submit({ agentId: "ceo", instruction: "Run the company", taskId: "pg-root" });
    a.cascade.start();
    b.cascade.start();
    const done = await b.cascade.wait("pg-root", { timeoutMs: 20_000, pollIntervalMs: 20 });
    expect(done.status).toBe("succeeded");
    expect(done.outputText).toBe("All done.");
    expect((await a.cascade.tree("pg-root")).map((task) => task.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("cascade actor", () => {
  it("records who started a cascade on every task, event and turn", async () => {
    const actor = {
      subjectId: "owner",
      actorType: "human",
      credentialSource: "passkey",
      displayName: "Owner",
    } as const;
    const { executor, calls } = scriptedExecutor({
      ceo: (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({ delegate_task: [{ to: "vp-ops", task: "x" }] }),
            }
          : { status: "succeeded", outputText: "done" },
    });
    const { cascade, runStore } = await openHarness(executor);
    await cascade.submit({ agentId: "ceo", instruction: "x", taskId: "who", actor });
    await cascade.drain();

    for (const taskId of ["who", "who.0.1"]) {
      expect((await cascade.get(taskId))?.actor).toEqual(actor);
      expect((await runStore.getRun(taskId))?.envelope.actor).toEqual(actor);
      const events = await runStore.readEvents(taskId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.actor?.subjectId === "owner")).toBe(true);
    }
    expect(calls.every((call) => call.actor?.subjectId === "owner")).toBe(true);
  });
});

describe("goal-gated tasks (R24)", () => {
  const reportGoal = {
    id: "report",
    objective: "Report the headcount as JSON.",
    definitionOfDone: ["The output is JSON with a numeric headcount of at least 10"],
    validators: [
      {
        id: "shape",
        kind: "output_schema",
        schema: {
          type: "object",
          required: ["headcount"],
          properties: { headcount: { type: "number" } },
        },
      },
      {
        id: "size",
        kind: "numeric",
        source: { outputPath: "headcount" },
        operator: "gte",
        value: 10,
      },
    ],
  } as const;

  it("keeps a task going until its goal validators report COMPLETE", async () => {
    const { executor, calls } = scriptedExecutor({
      analyst: (_input, turn) => ({
        status: "succeeded",
        outputText: turn === 1 ? "About eight people." : json({ headcount: 12 }),
      }),
    });
    const { cascade, runStore } = await openHarness(executor);
    const submitted = await cascade.submit({
      agentId: "analyst",
      instruction: "Count the team",
      taskId: "count",
      goal: { spec: reportGoal },
    });
    expect(submitted.goal?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await cascade.drain();

    const task = await cascade.get("count");
    expect(task?.status).toBe("succeeded");
    expect(task?.validationFailures).toBe(1);
    expect(task?.lastGoalReport?.status).toBe("COMPLETE");
    expect(calls[0]?.prompt).toContain("Report the headcount as JSON.");
    expect(calls[1]?.prompt).toContain("Your last result did not pass validation");
    expect(calls[1]?.prompt).toContain("shape");

    // Each in-run verdict is logged for goal evals to cross-check.
    const verdicts = (await runStore.readEvents("count")).filter(
      (event) => event.name === "plugin.delegation.goal.validated",
    );
    expect(verdicts.map((event) => event.data["status"])).toEqual(["INCOMPLETE", "COMPLETE"]);
    expect(verdicts.every((event) => event.data["goalId"] === reportGoal.id)).toBe(true);
    expect(verdicts[1]?.data["goalFingerprint"]).toBe(submitted.goal?.fingerprint);
  });

  it("checks the turn's trace and host-registered checks", async () => {
    const goal = {
      id: "research",
      objective: "Read the ledger and pass the audit check.",
      definitionOfDone: ["The ledger was read", "The audit check passes"],
      validators: [
        { id: "read-ledger", kind: "trace", require: [{ tool: "read_file" }] },
        { id: "audit", kind: "check", checkRef: "audit" },
      ],
    } as const;
    let harness: Harness | undefined;
    const executor: AgentTaskExecutor = async (input) => {
      const turn = Number(/attempt-(\d+)/.exec(input.attemptRunId)?.[1] ?? "1");
      if (turn > 1) {
        await harness?.runStore.appendEvents(input.attemptRunId, [
          {
            eventId: `${input.attemptRunId}:1`,
            sequence: 1,
            occurredAt: new Date().toISOString(),
            name: "tool.call.completed",
            origin: { namespace: "core" },
            scopeId: "s",
            runId: input.attemptRunId,
            rootSessionId: "r",
            sessionId: "r",
            data: { toolName: "read_file", args: { path: "ledger.csv" } },
          },
        ]);
      }
      return { status: "succeeded", outputText: `audit ok ${turn}`, runIds: [input.attemptRunId] };
    };
    harness = await openHarness(executor, {
      goals: {
        checks: {
          audit: ({ evidence }) => ({
            passed: evidence.outputText?.startsWith("audit ok") === true,
            message: "Audit failed.",
          }),
        },
      },
    });
    await harness.cascade.submit({
      agentId: "analyst",
      instruction: "Audit",
      taskId: "audit",
      goal: { spec: goal },
    });
    await harness.cascade.drain();
    const task = await harness.cascade.get("audit");
    expect(task?.status).toBe("succeeded");
    expect(task?.validationFailures).toBe(1);
    expect(task?.lastGoalReport?.passed).toBe(2);
    // Each check's outcome is kept so the owner sees a live checklist.
    expect(task?.lastGoalReport?.checks?.length).toBeGreaterThan(0);
    expect(task?.lastGoalReport?.checks?.every((check) => check.status === "passed")).toBe(true);
  });

  it("fails closed when a goal's check is not registered", async () => {
    const { executor } = scriptedExecutor({});
    const { cascade } = await openHarness(executor, { maxValidationAttempts: 1 });
    await cascade.submit({
      agentId: "analyst",
      instruction: "x",
      taskId: "unregistered",
      goal: {
        spec: {
          id: "g",
          objective: "o",
          definitionOfDone: ["d"],
          validators: [{ id: "c", kind: "check", checkRef: "missing" }],
        },
      },
    });
    await cascade.drain();
    const task = await cascade.get("unregistered");
    expect(task?.status).toBe("failed");
    expect(task?.lastGoalReport?.status).toBe("INCOMPLETE");
  });

  it("rejects an invalid goal at submit time", async () => {
    const { executor } = scriptedExecutor({});
    const { cascade } = await openHarness(executor);
    await expect(
      cascade.submit({
        agentId: "analyst",
        instruction: "x",
        goal: { spec: { id: "g", objective: "o", definitionOfDone: [], validators: [] } as never },
      }),
    ).rejects.toThrow(/goal/i);
  });

  it("refuses a goal that was changed after the task was created", async () => {
    const { executor } = scriptedExecutor({
      analyst: () => ({ status: "succeeded", outputText: json({ headcount: 1 }) }),
    });
    const { cascade, runStore } = await openHarness(executor, { maxValidationAttempts: 1 });
    await cascade.submit({
      agentId: "analyst",
      instruction: "x",
      taskId: "tamper",
      goal: { spec: reportGoal },
    });
    // Someone lowers the bar in storage after submission.
    const record = await runStore.getRun("tamper");
    const stored = record?.metadata?.["task"] as Record<string, unknown>;
    const goal = stored["goal"] as Record<string, unknown>;
    const spec = goal["spec"] as Record<string, unknown>;
    const validators = spec["validators"] as Array<Record<string, unknown>>;
    await runStore.saveRun({
      envelope: record?.envelope as never,
      metadata: {
        ...(record?.metadata ?? {}),
        task: {
          ...stored,
          goal: {
            ...goal,
            spec: { ...spec, validators: [validators[0], { ...validators[1], value: 0 }] },
          },
        } as never,
      },
    });
    await cascade.drain();
    const task = await cascade.get("tamper");
    expect(task?.status).toBe("failed");
    expect(task?.failureMessage).toMatch(/goal/i);
  });

  it("lets a manager attach a checked goal to delegated work", async () => {
    const { executor, calls } = scriptedExecutor({
      "vp-research": (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({
                delegate_task: [{ to: "analyst", task: "Count", goal: reportGoal }],
              }),
            }
          : { status: "succeeded", outputText: "Team counted." },
      analyst: (_input, turn) => ({
        status: "succeeded",
        outputText: turn === 1 ? json({ headcount: 3 }) : json({ headcount: 11 }),
      }),
    });
    const { cascade } = await openHarness(executor);
    await cascade.submit({ agentId: "vp-research", instruction: "Count", taskId: "mgr" });
    await cascade.drain();
    const child = await cascade.get("mgr.0.1");
    expect(child?.goal?.spec?.id).toBe("report");
    expect(child?.goal?.fingerprint).toBeDefined();
    expect(child?.status).toBe("succeeded");
    expect(child?.validationFailures).toBe(1);
    expect((await cascade.get("mgr"))?.status).toBe("succeeded");
    expect(calls.filter((call) => call.agentId === "analyst")).toHaveLength(2);
  });

  it("sends an invalid delegated goal back to the manager", async () => {
    const { executor, calls } = scriptedExecutor({
      "vp-research": (_input, turn) =>
        turn === 1
          ? {
              status: "succeeded",
              outputText: json({
                delegate_task: [{ to: "analyst", task: "Count", goal: { id: "bad" } }],
              }),
            }
          : { status: "succeeded", outputText: "Did it myself." },
    });
    const { cascade } = await openHarness(executor);
    await cascade.submit({ agentId: "vp-research", instruction: "Count", taskId: "badgoal" });
    await cascade.drain();
    expect((await cascade.get("badgoal"))?.childTaskIds).toEqual([]);
    expect(calls[1]?.prompt).toContain("is not a valid goal spec");
  });
});

describe("safe resume of interrupted turns", () => {
  function sendTool(outbox: string[]) {
    return withAgentHarnessToolEffects(
      {
        name: "send_email",
        async execute(_id: string, params: { to: string; body: string }) {
          outbox.push(`${params.to}: ${params.body}`);
          return { content: [{ type: "text", text: `sent to ${params.to}` }] };
        },
      },
      ["message.send"],
    );
  }

  it("replays sends from a crashed attempt instead of sending them again", async () => {
    const outbox: string[] = [];
    const events: DelegationCascadeEvent[] = [];
    const { executor, calls } = scriptedExecutor({});
    const wrapped: AgentTaskExecutor = async (input) => {
      await executor(input);
      const send = createToolEffectGuard(input.effectJournal as ToolEffectJournal).wrap(
        sendTool(outbox),
      );
      await send.execute("1", { to: "ann", body: "quote" });
      await send.execute("2", { to: "bob", body: "quote" });
      if (calls.length === 1) {
        return { status: "failed", outputText: "", failureMessage: "worker lost the model" };
      }
      return { status: "succeeded", outputText: "Quotes sent." };
    };
    const { cascade, runStore } = await openHarness(wrapped, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Send quotes", taskId: "quotes" });
    await cascade.drain();

    expect((await cascade.get("quotes"))?.status).toBe("succeeded");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.effectJournal?.scopeId).toBe("quotes:turn-0");
    expect(calls[1]?.effectJournal?.scopeId).toBe("quotes:turn-0");
    expect(outbox).toEqual(["ann: quote", "bob: quote"]);
    expect(events.filter((event) => event.type === "tool.effect.replayed")).toHaveLength(2);
    const records = await listToolEffectRecords(runStore, "quotes", "quotes:turn-0");
    expect(records.map((record) => record.status)).toEqual(["completed", "completed"]);
    const log = await runStore.readEvents("quotes");
    expect(
      log.filter((event) => event.name === "plugin.delegation.tool-effect-replayed"),
    ).toHaveLength(2);
  });

  it("refuses to repeat a send whose outcome was never recorded", async () => {
    const outbox: string[] = [];
    const events: DelegationCascadeEvent[] = [];
    const refusals: string[] = [];
    let attempt = 0;
    const executor: AgentTaskExecutor = async (input) => {
      attempt += 1;
      const journal = input.effectJournal as ToolEffectJournal;
      // The first worker dies right after the send starts, before it can record the outcome.
      const visible: ToolEffectJournal =
        attempt === 1
          ? {
              scopeId: journal.scopeId,
              read: (key) => journal.read(key),
              write: (record) => (record.status === "started" ? journal.write(record) : undefined),
            }
          : journal;
      const send = createToolEffectGuard(visible).wrap(sendTool(outbox));
      try {
        await send.execute("1", { to: "ann", body: "invoice" });
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : String(error));
      }
      return attempt === 1
        ? { status: "failed", outputText: "", failureMessage: "worker died" }
        : { status: "succeeded", outputText: "Checked the sent folder; the invoice went out." };
    };
    const { cascade } = await openHarness(executor, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Invoice", taskId: "invoice" });
    await cascade.drain();

    expect((await cascade.get("invoice"))?.status).toBe("succeeded");
    expect(outbox).toEqual(["ann: invoice"]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("may already have happened");
    expect(events.filter((event) => event.type === "tool.effect.uncertain")).toHaveLength(1);
  });

  it("acts on a saved answer instead of running the model again", async () => {
    const { executor, calls } = scriptedExecutor({});
    let validations = 0;
    const { cascade, runStore } = await openHarness(executor, {
      validate: () => {
        validations += 1;
        if (validations === 1) {
          throw new Error("worker crashed after the model answered");
        }
        return { passed: true };
      },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Summarize", taskId: "sum" });
    await cascade.drain();

    const task = await cascade.get("sum");
    expect(task?.status).toBe("succeeded");
    expect(task?.outputText).toBe("analyst did: sum");
    expect(calls).toHaveLength(1);
    expect(validations).toBe(2);
    expect((await runStore.getSession(turnCheckpointSessionId("sum", 0)))?.status).toBe(
      "succeeded",
    );
    const log = await runStore.readEvents("sum");
    expect(log.some((event) => event.data?.["fromCheckpoint"] === true)).toBe(true);
  });
});

describe("delegate_task and finish_task tools", () => {
  async function call(
    input: AgentTaskExecutionInput,
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }> {
    const tool = input.tools?.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new Error(`no ${name} tool`);
    }
    return tool.execute(params as never, { toolCallId: `${name}-call` });
  }

  it("delegates through the tool and checks hand-offs during the turn", async () => {
    const replies: Array<{ text: string; isError?: boolean }> = [];
    const { executor, calls } = scriptedExecutor({});
    const wrapped: AgentTaskExecutor = async (input) => {
      const scripted = await executor(input);
      if (input.agentId !== "ceo" || calls.filter((c) => c.agentId === "ceo").length > 1) {
        return scripted;
      }
      replies.push(await call(input, "delegate_task", { tasks: [{ to: "nobody", task: "x" }] }));
      replies.push(await call(input, "delegate_task", { tasks: [{ to: "analyst", task: "x" }] }));
      replies.push(
        await call(input, "delegate_task", {
          tasks: [{ to: "vp-ops", task: "Book a venue", definitionOfDone: "A signed contract" }],
        }),
      );
      // The prose reply is ignored once the tool recorded a delegation.
      return { status: "succeeded", outputText: "Handed the venue to operations." };
    };
    const { cascade } = await openHarness(wrapped);
    await cascade.submit({ agentId: "ceo", instruction: "Plan the offsite", taskId: "offsite" });
    await cascade.drain();

    expect(replies[0]?.isError).toBe(true);
    expect(replies[0]?.text).toContain('no agent "nobody"');
    expect(replies[1]?.isError).toBe(true);
    expect(replies[1]?.text).toContain("does not report to you");
    expect(replies[2]?.isError).toBeUndefined();
    const root = await cascade.get("offsite");
    expect(root?.status).toBe("succeeded");
    expect(root?.childTaskIds).toEqual(["offsite.0.1"]);
    const child = await cascade.get("offsite.0.1");
    expect(child?.agentId).toBe("vp-ops");
    expect(child?.goal?.definitionOfDone).toBe("A signed contract");
    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "delegate_task",
      "submit_work",
      "declare_impossible",
      "ask_owner",
    ]);
    expect(calls[0]?.prompt).toContain("call the delegate_task tool");
  });

  it("offers no delegate_task to agents with nobody to delegate to", async () => {
    const { executor, calls } = scriptedExecutor({});
    const wrapped: AgentTaskExecutor = async (input) => {
      await executor(input);
      await call(input, "declare_impossible", { reason: "The data source is gone." });
      return { status: "succeeded", outputText: "Sorry." };
    };
    const { cascade } = await openHarness(wrapped, {
      impossibility: () => ({ impossible: true, reasoning: "It was deleted.", reviewer: "r" }),
    });
    await cascade.submit({ agentId: "analyst", instruction: "Pull data", taskId: "pull" });
    await cascade.drain();

    expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "submit_work",
      "declare_impossible",
      "ask_owner",
    ]);
    const task = await cascade.get("pull");
    expect(task?.status).toBe("failed");
    expect(task?.failureMessage).toBe(
      "Declared impossible: The data source is gone.\nConfirmed by r: It was deleted.",
    );
  });

  it("saves tool directives in the turn checkpoint", async () => {
    let turns = 0;
    const executor: AgentTaskExecutor = async (input) => {
      if (input.agentId !== "ceo") {
        return { status: "succeeded", outputText: "Venue booked." };
      }
      turns += 1;
      if (turns === 1) {
        await call(input, "delegate_task", { tasks: [{ to: "vp-ops", task: "Book a venue" }] });
        return { status: "succeeded", outputText: "Delegated." };
      }
      return { status: "succeeded", outputText: "Offsite planned." };
    };
    const { cascade, runStore } = await openHarness(executor);
    await cascade.submit({ agentId: "ceo", instruction: "Plan the offsite", taskId: "offsite" });
    await cascade.drain();

    const checkpoint = await runStore.getSession(turnCheckpointSessionId("offsite", 0));
    expect((checkpoint?.state as { directives?: unknown } | undefined)?.directives).toEqual({
      delegate_task: [{ to: "vp-ops", task: "Book a venue" }],
    });
    expect((await cascade.get("offsite"))?.status).toBe("succeeded");
    expect(turns).toBe(2);
  });
});

describe("owner messages to a running turn (decision 5)", () => {
  it("hands an owner note to the running turn once, then not again next round", async () => {
    let harness: Harness | undefined;
    const steered: string[][] = [];
    const prompts: string[] = [];
    const executor: AgentTaskExecutor = async (input) => {
      prompts.push(input.prompt);
      if (prompts.length === 1) {
        await harness?.cascade.notify(input.taskId, "Use the Austin venue.");
        steered.push([...((await input.steering?.()) ?? [])]);
        steered.push([...((await input.steering?.()) ?? [])]);
      }
      return { status: "succeeded", outputText: "Done." };
    };
    harness = await openHarness(executor);
    await harness.cascade.submit({ agentId: "ceo", instruction: "Book a venue", taskId: "venue" });
    await harness.cascade.drain();

    expect(steered[0]).toEqual(["Message from the owner while you work: Use the Austin venue."]);
    expect(steered[1]).toEqual([]);
    expect((await harness.cascade.get("venue"))?.status).toBe("succeeded");
  });
});

describe("holds: pause and limits (decisions 15 and 33)", () => {
  it("parks a held agent's task and gives it a fresh turn once the hold lifts", async () => {
    let paused = true;
    const { executor, calls } = scriptedExecutor({});
    const events: string[] = [];
    const harness = await openHarness(executor, {
      holdFor: (agentId) =>
        paused && agentId === "ceo" ? { kind: "owner-pause", reason: "Paused." } : undefined,
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    await harness.cascade.submit({ agentId: "ceo", instruction: "Plan the offsite", taskId: "t" });
    await harness.cascade.drain();

    expect(calls).toHaveLength(0);
    const held = await harness.cascade.get("t");
    expect(held?.status).toBe("queued");
    expect(held?.hold).toMatchObject({ kind: "owner-pause", reason: "Paused." });
    expect(events).toContain("task.held");

    // Still held: nothing resumes, and recovery leaves it alone.
    expect(await harness.cascade.resumeHeld()).toBe(0);
    expect(await harness.cascade.recover()).toBe(0);
    await harness.cascade.drain();
    expect(calls).toHaveLength(0);

    paused = false;
    expect(await harness.cascade.resumeHeld()).toBe(1);
    await harness.cascade.drain();
    const done = await harness.cascade.get("t");
    expect(done?.status).toBe("succeeded");
    expect(done?.hold).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("stops a running turn after its step and parks it instead of failing", async () => {
    let paused = false;
    const stops: boolean[] = [];
    const executor: AgentTaskExecutor = async (input) => {
      if (input.prompt.includes("The hold is lifted")) {
        return { status: "succeeded", outputText: "Picked up and finished." };
      }
      paused = true; // the owner presses pause mid-turn
      stops.push((await input.stopRequested?.()) === true);
      return {
        status: "failed",
        outputText: "",
        failureMessage: "Stopped after the current step.",
      };
    };
    const harness = await openHarness(executor, {
      holdFor: () => (paused ? { kind: "owner-pause", reason: "Paused." } : undefined),
    });
    await harness.cascade.submit({ agentId: "analyst", instruction: "Research", taskId: "r" });
    await harness.cascade.drain();

    expect(stops).toEqual([true]);
    const parked = await harness.cascade.get("r");
    expect(parked?.status).toBe("queued");
    expect(parked?.hold?.reason).toBe("Paused.");

    paused = false;
    expect(await harness.cascade.resumeHeld()).toBe(1);
    await harness.cascade.drain();
    expect(await harness.cascade.get("r")).toMatchObject({
      status: "succeeded",
      outputText: "Picked up and finished.",
    });
  });
});

describe("goals on every request (ADR 0069)", () => {
  type Use = (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ text: string; isError?: boolean }>;
  type Turn = (
    input: AgentTaskExecutionInput,
    use: Use,
    turn: number,
  ) => Promise<string | undefined> | string | undefined;

  /** Each agent's turns call cascade tools through `use`, then return their reply text. */
  function toolExecutor(scripts: Record<string, Turn>) {
    const calls: AgentTaskExecutionInput[] = [];
    const results: Array<{ agentId: string; tool: string; text: string; isError?: boolean }> = [];
    const turns = new Map<string, number>();
    const executor: AgentTaskExecutor = async (input) => {
      calls.push(input);
      const turn = (turns.get(input.taskId) ?? 0) + 1;
      turns.set(input.taskId, turn);
      const use: Use = async (name, params) => {
        const tool = input.tools?.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          const missing = { text: `no ${name} tool`, isError: true };
          results.push({ agentId: input.agentId, tool: name, ...missing });
          return missing;
        }
        const result = await tool.execute(params as never, { toolCallId: `${name}-${turn}` });
        results.push({ agentId: input.agentId, tool: name, ...result });
        return result;
      };
      const reply = await scripts[input.agentId]?.(input, use, turn);
      return { status: "succeeded", outputText: reply ?? "" };
    };
    return { executor, calls, results };
  }

  const answerGoal = {
    objective: "Answer the owner's question.",
    definitionOfDone: ["The answer names the capital of France."],
    validators: [{ id: "answer-checked", kind: "check", checkRef: "mentions-paris" }],
  };
  const mentionsParis = {
    "mentions-paris": ({ evidence }: { evidence: { outputText?: string } }) => ({
      passed: /paris/i.test(evidence.outputText ?? ""),
      message: "The answer must name Paris.",
    }),
  };

  it("finishes a task only when the agent hands in with submit_work", async () => {
    const { executor, calls, results } = toolExecutor({
      analyst: async (_input, use, turn) => {
        if (turn === 1) {
          return "I think it is done."; // no hand-in
        }
        await use("submit_work", {
          summary: "Brief written.",
          deliverables: [{ path: "drive/goals/brief/deliverables/brief.md", title: "Brief" }],
        });
        return "Handed in.";
      },
    });
    const { cascade } = await openHarness(executor, { handIn: "tool" });
    await cascade.submit({ agentId: "analyst", instruction: "Write the brief", taskId: "brief" });
    await cascade.drain();

    const task = await cascade.get("brief");
    expect(task?.status).toBe("succeeded");
    expect(task?.round).toBe(1);
    expect(calls[1]?.prompt).toContain("You ended your turn without handing anything in");
    expect(task?.handIn).toMatchObject({
      summary: "Brief written.",
      deliverables: [{ path: "drive/goals/brief/deliverables/brief.md", title: "Brief" }],
      round: 1,
    });
    expect(task?.outputText).toBe(
      "Brief written.\n\nDeliverables:\n- drive/goals/brief/deliverables/brief.md (Brief)",
    );
    expect(results.find((result) => result.tool === "submit_work")?.text).toMatch(/Handed in/);
  });

  it("lets the host refuse a hand-in during the turn and checks the hand-in as output", async () => {
    const { executor, results } = toolExecutor({
      analyst: async (_input, use) => {
        const first = await use("submit_work", {
          summary: "Done.",
          deliverables: [{ path: "drive/missing.md" }],
        });
        if (first.isError === true) {
          await use("submit_work", { summary: "Done.", deliverables: ["drive/brief.md"] });
        }
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      checkHandIn: ({ deliverables }) =>
        deliverables.some((deliverable) => deliverable.path.includes("missing"))
          ? "drive/missing.md does not exist."
          : undefined,
    });
    await cascade.submit({
      agentId: "analyst",
      instruction: "Write the brief",
      taskId: "brief",
      goal: {
        spec: {
          id: "brief",
          objective: "A brief.",
          definitionOfDone: ["One deliverable."],
          validators: [
            {
              id: "one-file",
              kind: "output_schema",
              schema: {
                type: "object",
                required: ["deliverables"],
                properties: { deliverables: { type: "array", minItems: 1 } },
              },
            },
          ],
        },
      },
    });
    await cascade.drain();

    expect(results[0]).toMatchObject({
      isError: true,
      text: expect.stringMatching(/does not exist/),
    });
    const task = await cascade.get("brief");
    expect(task?.status).toBe("succeeded");
    expect(task?.lastGoalReport?.status).toBe("COMPLETE");
  });

  it("has the agent draft the goal first and locks it once set", async () => {
    const { executor, calls, results } = toolExecutor({
      ceo: async (_input, use, turn) => {
        if (turn === 1) {
          await use("submit_work", { summary: "Paris." }); // refused: no goal yet
          await use("set_goal", {
            objective: "Answer.",
            definitionOfDone: ["Name the capital."],
            validators: [
              {
                id: "self-reported",
                kind: "numeric",
                source: { outputPath: "confidence" },
                operator: "gte",
                value: 0.9,
              },
            ],
          }); // refused: self-reported number
          await use("set_goal", answerGoal);
          await use("set_goal", answerGoal); // refused: locked
          await use("submit_work", { summary: "Lyon." });
          return "";
        }
        await use("submit_work", { summary: "Paris." });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      goals: { checks: mentionsParis, metrics: { deliverableWords: "Words in the deliverable." } },
    });
    await cascade.submit({
      agentId: "ceo",
      instruction: "What is the capital of France?",
      taskId: "q1",
      draftGoal: true,
    });
    await cascade.drain();

    expect(calls[0]?.prompt).toContain("No goal is set for this request yet");
    expect(calls[0]?.prompt).toContain("deliverableWords: Words in the deliverable.");
    expect(calls[0]?.tools?.map((tool) => tool.name)).toContain("set_goal");
    expect(results.map((result) => [result.tool, result.isError === true])).toEqual([
      ["submit_work", true],
      ["set_goal", true],
      ["set_goal", false],
      ["set_goal", true],
      ["submit_work", false],
      ["submit_work", false],
    ]);
    expect(results[1]?.text).toMatch(/host measures/);
    expect(results[3]?.text).toMatch(/locked/);
    // The second turn has no set_goal tool and shows the locked goal.
    expect(calls[1]?.tools?.map((tool) => tool.name)).not.toContain("set_goal");
    expect(calls[1]?.prompt).toContain("The goal is locked");
    expect(calls[1]?.prompt).toContain("The answer must name Paris.");

    const task = await cascade.get("q1");
    expect(task?.status).toBe("succeeded");
    expect(task?.goalDraft).toBe("set");
    expect(task?.goal?.spec?.id).toBe("q1");
    expect(task?.goalHistory).toEqual([
      expect.objectContaining({ revision: 1, source: "agent", changedBy: "ceo" }),
    ]);
  });

  it("sends a turn back when the goal is still not drafted", async () => {
    const { executor, calls } = toolExecutor({
      ceo: async (_input, use, turn) => {
        if (turn === 1) {
          return "Paris, obviously.";
        }
        await use("set_goal", answerGoal);
        await use("submit_work", { summary: "Paris." });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      goals: { checks: mentionsParis },
    });
    await cascade.submit({ agentId: "ceo", instruction: "Capital?", taskId: "q", draftGoal: true });
    await cascade.drain();
    expect(calls[1]?.prompt).toContain("No goal is set for this request yet. Call set_goal");
    expect((await cascade.get("q"))?.status).toBe("succeeded");
  });

  it("keeps going when the reviewer says the task is only hard, and stops when it agrees", async () => {
    const reviews: string[] = [];
    const { executor, calls } = toolExecutor({
      analyst: async (input, use) => {
        await use("declare_impossible", {
          reason:
            input.taskId === "pnp" ? "P vs NP is too hard." : "The earth cannot be teleported.",
        });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      maxRounds: 2,
      impossibility: ({ reason, agent }) => {
        reviews.push(`${agent.id}: ${reason}`);
        return reason.includes("teleported")
          ? { impossible: true, reasoning: "Violates physics.", reviewer: "openai/other" }
          : { impossible: false, reasoning: "Open problem, not known to be impossible." };
      },
    });
    await cascade.submit({ agentId: "analyst", instruction: "Prove P != NP", taskId: "pnp" });
    await cascade.submit({ agentId: "analyst", instruction: "Teleport earth", taskId: "earth" });
    await cascade.drain();

    const earth = await cascade.get("earth");
    expect(earth?.status).toBe("failed");
    expect(earth?.impossible?.review).toEqual({
      impossible: true,
      reasoning: "Violates physics.",
      reviewer: "openai/other",
    });
    const pnp = await cascade.get("pnp");
    expect(pnp?.impossible).toBeUndefined();
    expect(pnp?.impossibilityClaims?.[0]?.review?.impossible).toBe(false);
    const pnpTurns = calls.filter((call) => call.taskId === "pnp");
    expect(pnpTurns[1]?.prompt).toContain(
      "A reviewer did not agree that the task is impossible in principle, so keep going.",
    );
    expect(pnpTurns[1]?.prompt).toContain("Open problem, not known to be impossible.");
  });

  it("never confirms impossibility without a reviewer", async () => {
    const { executor, calls } = toolExecutor({
      analyst: async (_input, use, turn) => {
        if (turn === 1) {
          await use("declare_impossible", { reason: "Too hard." });
        } else {
          await use("submit_work", { summary: "Did it after all." });
        }
        return "";
      },
    });
    const { cascade } = await openHarness(executor, { handIn: "tool" });
    await cascade.submit({ agentId: "analyst", instruction: "x", taskId: "x" });
    await cascade.drain();
    expect(calls[1]?.prompt).toContain("could not be reviewed");
    const task = await cascade.get("x");
    expect(task?.status).toBe("succeeded");
    expect(task?.impossibilityClaims?.[0]?.reviewError).toMatch(/No reviewer/);
  });

  it("applies owner edits to the definition of done and tells everyone on the goal", async () => {
    const judged: string[][] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { executor, calls } = toolExecutor({
      ceo: async (_input, use, turn) => {
        if (turn === 1) {
          await use("delegate_task", { tasks: [{ to: "vp-ops", task: "Plan it" }] });
          return "";
        }
        await use("submit_work", { summary: "Plan done." });
        return "";
      },
      "vp-ops": async (_input, use, turn) => {
        if (turn === 1) {
          await gate;
          return "still working"; // no hand-in: sent back
        }
        await use("submit_work", { summary: "Plan with a budget." });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      goals: {
        judges: (request) => {
          judged.push([...request.definitionOfDone]);
          return {
            criteria: request.criteria.map((criterion) => ({
              criterionId: criterion.id,
              score: 1,
            })),
          };
        },
      },
    });
    await cascade.submit({
      agentId: "ceo",
      instruction: "Plan the offsite",
      taskId: "offsite",
      goal: {
        spec: {
          id: "offsite",
          objective: "An offsite plan.",
          definitionOfDone: ["A dated agenda."],
          validators: [
            { id: "quality", kind: "rubric", criteria: [{ id: "agenda", description: "Dated." }] },
          ],
        },
      },
    });
    const worker = cascade.drain();
    // Wait until the VP's first turn is running, then edit the goal.
    for (let i = 0; i < 200 && !calls.some((call) => call.agentId === "vp-ops"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const edited = await cascade.updateGoal(
      "offsite",
      { definitionOfDone: ["A dated agenda.", "A budget under $5,000."] },
      { changedBy: "owner" },
    );
    release?.();
    await worker;
    await cascade.drain();

    expect(edited.goalRevision).toBe(2);
    expect(edited.goal?.spec?.validators.map((validator) => validator.id)).toEqual([
      "quality",
      "definition-of-done",
    ]);
    const vpTurns = calls.filter((call) => call.agentId === "vp-ops");
    expect(vpTurns[1]?.prompt).toContain("## New since your last step");
    expect(vpTurns[1]?.prompt).toContain("A budget under $5,000.");
    const ceoTurns = calls.filter((call) => call.agentId === "ceo");
    expect(ceoTurns[1]?.prompt).toContain("The owner changed the definition of done (revision 2)");
    // The checks ran against the new version.
    expect(judged.at(-1)).toEqual(["A dated agenda.", "A budget under $5,000."]);

    const root = await cascade.get("offsite");
    expect(root?.status).toBe("succeeded");
    // Each line of the definition of done has its own tick on the owner's checklist.
    const dod = root?.lastGoalReport?.checks?.find(
      (check) => check.validatorId === "definition-of-done",
    );
    expect(dod?.criteria?.map((criterion) => [criterion.criterionId, criterion.passed])).toEqual([
      ["dod-1", true],
      ["dod-2", true],
    ]);
    expect(root?.goalHistory?.map((entry) => [entry.revision, entry.source])).toEqual([
      [1, "submit"],
      [2, "owner"],
    ]);

    // Editing after it succeeded reopens the goal.
    const reopened = await cascade.updateGoal("offsite", {
      definitionOfDone: ["A dated agenda.", "A budget under $4,000."],
    });
    expect(reopened.status).toBe("queued");
    await cascade.drain();
    const after = await cascade.get("offsite");
    expect(after?.status).toBe("succeeded");
    expect(after?.goalRevision).toBe(3);
    expect(calls.filter((call) => call.agentId === "ceo").at(-1)?.prompt).toContain(
      "The owner changed the definition of done after you handed in",
    );
  });

  it("writes owner questions down without blocking, and delivers answers at the next step", async () => {
    const events: DelegationCascadeEvent[] = [];
    const { executor, calls, results } = toolExecutor({
      analyst: async (input, use, turn) => {
        if (turn === 1) {
          await use("ask_owner", {
            question: "Which region?",
            assumption: "Europe, since the owner is based there.",
          });
          return "keep going"; // no hand-in yet
        }
        if (turn === 2) {
          return "still going";
        }
        await use("submit_work", {
          summary: `Done for ${input.prompt.includes("APAC") ? "APAC" : "?"}`,
        });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      onEvent: (event) => events.push(event),
    });
    await cascade.submit({ agentId: "analyst", instruction: "Size the market", taskId: "m" });
    await cascade.drain({ maxJobs: 1 });

    const asked = await cascade.get("m");
    expect(asked?.status).toBe("queued");
    const question = asked?.ownerQuestions?.[0];
    expect(question).toMatchObject({ question: "Which region?", agentId: "analyst" });
    expect(results[0]?.text).toMatch(/Do not wait/);
    expect(events.some((event) => event.type === "task.owner_question")).toBe(true);

    await cascade.answerQuestion("m", question?.id as string, "APAC");
    await cascade.drain();
    expect(calls[1]?.prompt).toContain('The owner answered "Which region?": APAC');
    expect(calls[2]?.prompt).toContain("A: APAC");
    expect(calls[2]?.prompt).not.toContain("## New since your last step");
    expect((await cascade.get("m"))?.outputText).toBe("Done for APAC");
  });

  it("picks judges per agent so the judge can differ from the worker's model", async () => {
    const seen: string[] = [];
    const { executor } = toolExecutor({
      analyst: async (_input, use) => {
        await use("submit_work", { summary: "ok" });
        return "";
      },
    });
    const { cascade } = await openHarness(executor, {
      handIn: "tool",
      goals: {
        judgesFor:
          ({ agent }) =>
          () => {
            seen.push(agent.id);
            return { criteria: [{ criterionId: "c", score: 1 }] };
          },
      },
    });
    await cascade.submit({
      agentId: "analyst",
      instruction: "x",
      taskId: "x",
      goal: {
        spec: {
          id: "x",
          objective: "x",
          definitionOfDone: ["x"],
          validators: [{ id: "r", kind: "rubric", criteria: [{ id: "c", description: "c" }] }],
        },
      },
    });
    await cascade.drain();
    expect(seen).toEqual(["analyst"]);
    expect((await cascade.get("x"))?.status).toBe("succeeded");
  });
});
