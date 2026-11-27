import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { SessionManager } from "@generic-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BackgroundModel,
  type BackgroundRequest,
  createBackgroundGate,
  createMemoryBackgroundStore,
} from "./background.js";
import { createDreaming, sessionTranscript } from "./dreaming.js";
import { createCompanyHarvest } from "./harvest.js";
import { agentScope, COMPANY_SCOPE, createCompanyMemory } from "./memory.js";
import { MEMORY_SKILLS_DIR, syncMemorySkills } from "./memory-skills.js";
import { createSqliteStorageContract } from "./storage.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function writeSession(file: string, ask: string, answer: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const session = SessionManager.open(file);
  const timestamp = Date.now();
  session.appendMessage({ role: "user", content: ask, timestamp });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: answer }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as never);
}

function setup(replies: string[], clock = { now: new Date("2026-11-27T12:00:00Z") }) {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-dream-"));
  const sqlite = createSqliteStorage({ path: path.join(dir, "kv.sqlite") });
  cleanups.push(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const kv = createSqliteStorageContract(sqlite);
  const now = () => clock.now;
  const memory = createCompanyMemory({ kv, now });
  const store = createMemoryBackgroundStore({ kv, now });
  const companyRoot = path.join(dir, "company");
  const harvest = createCompanyHarvest({
    kv,
    companyRoot,
    root: path.join(dir, "harvest"),
    now,
  });
  const requests: BackgroundRequest[] = [];
  const model: BackgroundModel = async (request) => {
    requests.push(request);
    const text = replies.shift();
    if (text === undefined) {
      throw new Error("unexpected model call");
    }
    return { text, totalTokens: 900 };
  };
  const activity = new Map<string, Date | "working">();
  const sessionsRoot = path.join(dir, "sessions");
  const dreaming = createDreaming({
    memory,
    store,
    model,
    gate: createBackgroundGate({ store }),
    sessionsRoot,
    harvest,
    agents: async () => ["analyst", "ceo"],
    lastActive: async (agentId) => activity.get(agentId),
    now,
  });
  return {
    dir,
    memory,
    store,
    harvest,
    dreaming,
    requests,
    replies,
    activity,
    sessionsRoot,
    companyRoot,
    clock,
  };
}

describe("dreaming (decision 19)", () => {
  it("rereads recent sessions and edits only the agent's own memory, with undo", async () => {
    const proposal = {
      summary: "Kept the vendor lesson and merged duplicates",
      rationale: "The session showed net 45 terms twice.",
      expectedOutcome: "Fewer invoice mistakes.",
      edits: [
        {
          action: "create",
          kind: "memory",
          id: "vendor_terms",
          title: "Vendor terms",
          content: "Acme invoices net 45.",
        },
        { action: "delete", kind: "memory", id: "dup" },
        {
          action: "update",
          kind: "memory",
          id: "owner_note",
          title: "x",
          content: "Rewritten by dream.",
        },
        {
          action: "create",
          kind: "prompt",
          id: "tone",
          title: "Tone",
          content: "hack the handbook",
        },
      ],
    };
    const { memory, dreaming, requests, activity, sessionsRoot } = setup([
      JSON.stringify(proposal),
    ]);
    writeSession(
      path.join(sessionsRoot, "analyst", "goal-1.jsonl"),
      "Pay the Acme invoice",
      "Paid; Acme is net 45.",
    );
    expect(sessionTranscript(path.join(sessionsRoot, "analyst", "goal-1.jsonl"))).toContain(
      "net 45",
    );
    await memory.apply({
      scope: COMPANY_SCOPE,
      actor: { kind: "owner" },
      edits: [
        { action: "create", kind: "prompt", id: "tone", title: "Tone", content: "Plain words." },
      ],
    });
    await memory.apply({
      scope: agentScope("analyst"),
      actor: { kind: "agent", id: "analyst" },
      edits: [
        { action: "create", kind: "memory", id: "dup", title: "Dup", content: "Acme net 45" },
      ],
    });
    await memory.apply({
      scope: agentScope("analyst"),
      actor: { kind: "owner" },
      edits: [
        { action: "create", kind: "memory", id: "owner_note", title: "Note", content: "Mine." },
      ],
    });
    activity.set("analyst", new Date("2026-11-27T10:00:00Z"));

    const result = await dreaming.dream("analyst");
    expect(result).toMatchObject({ sessions: 1, applied: 3, refused: 1 });
    // The handbook is context, shown as read-only global entries.
    expect(requests[0]?.prompt).toContain("[global:tone]");
    expect(requests[0]?.prompt).toContain("Pay the Acme invoice");

    const own = await memory.list(agentScope("analyst"));
    expect(own.map((entry) => entry.id).sort()).toEqual(["owner_note", "tone", "vendor_terms"]);
    expect(own.find((entry) => entry.id === "owner_note")?.content).toBe("Mine.");
    expect(own.find((entry) => entry.id === "vendor_terms")?.origin).toMatchObject({
      kind: "dream",
      ref: "session goal-1",
    });
    // The handbook entry is untouched; the dream's "tone" went to the agent's own store.
    expect((await memory.list(COMPANY_SCOPE))[0]?.content).toBe("Plain words.");

    // One click undoes the whole dream.
    await memory.undo(result.change?.id as string, { kind: "owner" });
    expect((await memory.list(agentScope("analyst"))).map((entry) => entry.id).sort()).toEqual([
      "dup",
      "owner_note",
    ]);
  });

  it("dreams only when idle, spaced out, and with something new", async () => {
    const empty = JSON.stringify({
      summary: "Nothing",
      rationale: "",
      expectedOutcome: "",
      edits: [],
    });
    const { dreaming, requests, activity, sessionsRoot, clock, store } = setup([empty, empty]);
    expect(await dreaming.dream("analyst")).toMatchObject({
      skipped: "Nothing new since the last dream.",
    });
    writeSession(path.join(sessionsRoot, "analyst", "goal-1.jsonl"), "Do it", "Done.");
    activity.set("analyst", "working");
    expect(await dreaming.dream("analyst")).toMatchObject({ skipped: "The agent is working." });
    activity.set("analyst", new Date("2026-11-27T11:50:00Z"));
    expect(await dreaming.dream("analyst")).toMatchObject({
      skipped: "The agent has not been idle long enough.",
    });
    activity.set("analyst", new Date("2026-11-27T11:00:00Z"));
    expect((await dreaming.tick())?.agentId).toBe("analyst");
    expect(requests).toHaveLength(1);
    expect(await dreaming.dream("analyst")).toMatchObject({
      skipped: "The agent dreamed recently.",
    });
    clock.now = new Date("2026-11-27T20:00:00Z");
    expect(await dreaming.dream("analyst")).toMatchObject({
      skipped: "Nothing new since the last dream.",
    });
    await store.updateSettings({ paused: true });
    expect(await dreaming.dream("analyst", { force: true })).toMatchObject({
      skipped: "Background memory work is paused.",
    });
    expect(requests).toHaveLength(1);
  });
});

describe("script harvesting into saved procedures (decision 28)", () => {
  it("keeps scripts from accepted work and turns one into a skill the agent can run", async () => {
    const { memory, harvest, dreaming, activity, companyRoot, requests, replies } = setup([]);
    const write = {
      name: "write",
      execute: async (_id: string, params: { path: string; content: string }) => {
        const target = path.join(companyRoot, params.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, params.content);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const input = { taskId: "t1", agentId: "analyst", rootTaskId: "g1" } as never;
    const wrapped = harvest.wrapBindings(
      { fileTools: { piTools: [write] } } as never,
      input,
    ) as unknown as {
      fileTools: { piTools: (typeof write)[] };
    };
    const tool = wrapped.fileTools.piTools[0] as typeof write;
    await tool.execute("1", { path: "agents/analyst/workspace/count.py", content: "print(42)\n" });
    await tool.execute("2", { path: "drive/notes.md", content: "not a script" });
    await harvest.taskEnded("t-other");
    const saved = await harvest.taskSucceeded({
      taskId: "t1",
      rootTaskId: "g1",
      agentId: "analyst",
    });
    expect(saved.map((script) => script.sourcePath)).toEqual(["agents/analyst/workspace/count.py"]);
    // The agent changing its copy later does not change the harvest.
    writeFileSync(
      path.join(companyRoot, "agents/analyst/workspace/count.py"),
      "print('tampered')\n",
    );
    expect(await harvest.read(saved[0]?.id as string)).toBe("print(42)\n");

    // A failed task's scripts are dropped.
    const input2 = { taskId: "t2", agentId: "analyst", rootTaskId: "g2" } as never;
    const wrapped2 = harvest.wrapBindings(
      { fileTools: { piTools: [write] } } as never,
      input2,
    ) as unknown as {
      fileTools: { piTools: (typeof write)[] };
    };
    await (wrapped2.fileTools.piTools[0] as typeof write).execute("3", {
      path: "agents/analyst/workspace/bad.sh",
      content: "exit 1\n",
    });
    await harvest.taskEnded("t2");
    expect(
      await harvest.taskSucceeded({ taskId: "t2", rootTaskId: "g2", agentId: "analyst" }),
    ).toEqual([]);

    const scriptId = saved[0]?.id as string;
    replies.push(
      JSON.stringify({
        summary: "Saved the counting script",
        rationale: "It worked on goal g1.",
        expectedOutcome: "Reuse",
        edits: [
          {
            action: "create",
            kind: "skill",
            id: "count_things",
            title: "Count things",
            content: "Prints the count.",
            reference: { type: "command", command: "python3 {script}" },
            arguments: {},
            metadata: { harvestId: scriptId },
          },
        ],
      }),
    );
    activity.set("analyst", new Date("2026-11-27T10:00:00Z"));
    // No sessions were saved here; the new harvested script alone is reason to dream.
    const result = await dreaming.dream("analyst");
    expect(result).toMatchObject({ scripts: 1, applied: 1 });
    expect(requests[0]?.prompt).toContain(`<script id="${scriptId}"`);
    const [skill] = await memory.list(agentScope("analyst"));
    expect(skill).toMatchObject({ kind: "skill", id: "count_things" });
    expect(
      (await memory.read(agentScope("analyst"))).entries.skill["count_things"]?.metadata,
    ).toMatchObject({
      harvestId: scriptId,
      scriptFile: "count.py",
    });
  });

  it("lays out saved procedures as skill folders, and undo removes them", async () => {
    const { memory, harvest, companyRoot } = setup([]);
    const write = {
      name: "write",
      execute: async (_id: string, params: { path: string; content: string }) => {
        const target = path.join(companyRoot, params.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, params.content);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const wrapped = harvest.wrapBindings(
      { fileTools: { piTools: [write] } } as never,
      { taskId: "t1", agentId: "analyst", rootTaskId: "g1" } as never,
    ) as unknown as { fileTools: { piTools: (typeof write)[] } };
    await (wrapped.fileTools.piTools[0] as typeof write).execute("1", {
      path: "agents/analyst/workspace/count.py",
      content: "print(42)\n",
    });
    const [script] = await harvest.taskSucceeded({
      taskId: "t1",
      rootTaskId: "g1",
      agentId: "analyst",
    });
    const made = await memory.apply({
      scope: agentScope("analyst"),
      actor: { kind: "dream", id: "analyst" },
      edits: [
        {
          action: "create",
          kind: "skill",
          id: "count_things",
          title: "Count things",
          content: "Prints the count.",
          reference: { type: "command", command: "python3 {script}" },
          arguments: {},
          metadata: { harvestId: script?.id, scriptFile: script?.fileName },
        },
      ],
    });
    const home = path.join(companyRoot, "agents", "analyst");
    expect(await syncMemorySkills({ memory, harvest, agentId: "analyst", home })).toEqual([
      "count-things",
    ]);
    const skillDir = path.join(home, MEMORY_SKILLS_DIR, "count-things");
    expect(readFileSync(path.join(skillDir, "scripts", "count.py"), "utf8")).toBe("print(42)\n");
    const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skillMd).toContain("name: count-things");
    expect(skillMd).toContain(
      "python3 agents/analyst/.agents/memory-skills/count-things/scripts/count.py",
    );
    const section = await memory.promptSection("analyst");
    expect(section).toContain(
      "Run: `python3 agents/analyst/.agents/memory-skills/count-things/scripts/count.py`",
    );

    await memory.undo(made.change?.id as string, { kind: "owner" });
    await syncMemorySkills({ memory, harvest, agentId: "analyst", home });
    expect(existsSync(skillDir)).toBe(false);
  });
});
