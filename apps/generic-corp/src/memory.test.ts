import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentScope,
  COMPANY_SCOPE,
  type CompanyMemory,
  createCompanyMemory,
  type MemoryActor,
  refuseMemoryEdit,
} from "./memory.js";
import { createMemoryTools } from "./memory-tools.js";
import { createSqliteStorageContract } from "./storage.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function memoryFor(legacy: Record<string, string> = {}): CompanyMemory {
  const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-memory-"));
  const sqlite = createSqliteStorage({ path: path.join(directory, "kv.sqlite") });
  cleanups.push(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let tick = 0;
  return createCompanyMemory({
    kv: createSqliteStorageContract(sqlite),
    now: () => new Date(Date.UTC(2026, 10, 27, 2, 0, tick++)),
    legacyNotes: async (agentId) => {
      const notes = legacy[agentId];
      if (notes === undefined) {
        throw new Error("no file");
      }
      return notes;
    },
  });
}

const OWNER: MemoryActor = { kind: "owner" };

describe("company memory", () => {
  it("keeps a handbook and private memory, each entry with where it came from", async () => {
    const memory = memoryFor();
    const added = await memory.apply({
      scope: COMPANY_SCOPE,
      actor: OWNER,
      edits: [
        {
          action: "create",
          kind: "memory",
          title: "Owner",
          content: "Neill runs the company and reads updates on his phone.",
        },
      ],
    });
    expect(added.change?.actor.kind).toBe("owner");
    const [entry] = await memory.list(COMPANY_SCOPE);
    expect(entry).toMatchObject({ id: "owner", locked: true, origin: { kind: "owner" } });

    const agentResult = await memory.apply({
      scope: agentScope("researcher"),
      actor: { kind: "agent", id: "researcher" },
      origin: { kind: "agent", ref: "task-1" },
      edits: [
        { action: "create", kind: "memory", title: "Sources", content: "Prefer primary sources." },
      ],
    });
    expect(agentResult.edits[0]?.applied).toBe(true);
    const [own] = await memory.list(agentScope("researcher"));
    expect(own).toMatchObject({ locked: false, origin: { kind: "agent", ref: "task-1" } });
  });

  it("puts the handbook and the agent's memory in its prompt, most relevant first", async () => {
    const memory = memoryFor();
    await memory.apply({
      scope: COMPANY_SCOPE,
      actor: OWNER,
      edits: [
        { action: "create", kind: "memory", title: "Tone", content: "Short, plain answers." },
      ],
    });
    await memory.apply({
      scope: agentScope("ceo"),
      actor: { kind: "agent", id: "ceo" },
      edits: [
        {
          action: "create",
          kind: "memory",
          title: "Pricing",
          content: "Pricing pages need a table.",
        },
        {
          action: "create",
          kind: "memory",
          title: "Hiring",
          content: "Interview loops take a week.",
        },
      ],
    });
    const section = await memory.promptSection("ceo", { query: "Draft the hiring plan" });
    expect(section).toContain("## Company handbook");
    expect(section).toContain("- Tone: Short, plain answers.");
    expect(section.indexOf("Hiring")).toBeLessThan(section.indexOf("Pricing"));
    const other = await memory.promptSection("vp");
    expect(other).not.toContain("Hiring");
  });

  it("imports an agent's old notes file once", async () => {
    const memory = memoryFor({
      ceo: "# CEO (ceo)\n\nThis is your memory file. It persists across tasks. Keep it short and current:\nwhat you are responsible for, decisions you made, and what you learned.\n\nThe board meets on Fridays.\n",
      vp: "# VP (vp)\n\nThis is your memory file. It persists across tasks. Keep it short and current:\nwhat you are responsible for, decisions you made, and what you learned.\n",
    });
    const entries = await memory.list(agentScope("ceo"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("The board meets on Fridays.");
    expect(entries[0]?.origin?.kind).toBe("import");
    await memory.apply({
      scope: agentScope("ceo"),
      actor: OWNER,
      edits: [{ action: "delete", kind: "memory", id: "notes_before_memory" }],
    });
    expect(await memory.list(agentScope("ceo"))).toHaveLength(0);
    // An untouched template imports nothing.
    expect(await memory.list(agentScope("vp"))).toHaveLength(0);
  });

  it("undoes a change and refuses to undo over a later edit", async () => {
    const memory = memoryFor();
    const scope = agentScope("ceo");
    const actor: MemoryActor = { kind: "agent", id: "ceo" };
    const first = await memory.apply({
      scope,
      actor,
      edits: [{ action: "create", kind: "memory", id: "a", title: "A", content: "one" }],
    });
    const second = await memory.apply({
      scope,
      actor,
      edits: [{ action: "update", kind: "memory", id: "a", content: "two" }],
    });
    const undone = await memory.undo(second.change?.id as string, OWNER);
    expect(undone.change?.undoOf).toBe(second.change?.id);
    expect((await memory.list(scope))[0]?.content).toBe("one");
    await expect(memory.undo(second.change?.id as string, OWNER)).rejects.toThrow(/already undone/);

    // `first` created the entry, but the undo above changed it since: leave it, say why.
    const conflict = await memory.undo(first.change?.id as string, OWNER);
    expect(conflict.change).toBeUndefined();
    expect(conflict.edits[0]?.error).toMatch(/changed after/);

    await expect(memory.undo(first.change?.id as string, actor)).rejects.toThrow(/Only the owner/);
    const history = await memory.changes({ scope });
    expect(history.map((change) => change.summary)).toEqual([
      'Undid: Changed "A"',
      'Changed "A"',
      'Added "A"',
    ]);
    expect(history[1]?.undoneBy).toBe(undone.change?.id);
  });

  it("undoes a delete by bringing the entry back", async () => {
    const memory = memoryFor();
    const scope = agentScope("ceo");
    await memory.apply({
      scope,
      actor: OWNER,
      edits: [{ action: "create", kind: "memory", id: "x", title: "X", content: "keep" }],
    });
    const removed = await memory.apply({
      scope,
      actor: OWNER,
      edits: [{ action: "delete", kind: "memory", id: "x" }],
    });
    await memory.undo(removed.change?.id as string, OWNER);
    expect(await memory.list(scope)).toMatchObject([{ id: "x", content: "keep", locked: true }]);
  });
});

describe("who may change memory (decision 41)", () => {
  const edit = { action: "create" as const, kind: "memory" as const, title: "t", content: "c" };
  const locked = {
    id: "x",
    kind: "memory" as const,
    title: "x",
    content: "x",
    path: "general",
    reference: {},
    arguments: {},
    metadata: { locked: true },
    source: "owner",
    created_at: "",
    updated_at: "",
    version: 1,
  };

  it("keeps dreaming to the dreaming agent's own unlocked memory", () => {
    const dream: MemoryActor = { kind: "dream", id: "ceo" };
    expect(refuseMemoryEdit(dream, COMPANY_SCOPE, edit, undefined)).toMatch(/handbook/);
    expect(refuseMemoryEdit(dream, agentScope("vp"), edit, undefined)).toMatch(/its own/);
    expect(refuseMemoryEdit(dream, agentScope("ceo"), edit, locked)).toMatch(/only the owner/);
    expect(refuseMemoryEdit(dream, agentScope("ceo"), { ...edit, kind: "skill" }, undefined)).toBe(
      undefined,
    );
    expect(refuseMemoryEdit(dream, agentScope("ceo"), edit, undefined)).toBeUndefined();
  });

  it("lets agents write only memories of their own", () => {
    const agent: MemoryActor = { kind: "agent", id: "ceo" };
    expect(refuseMemoryEdit(agent, COMPANY_SCOPE, edit, undefined)).toMatch(/handbook/);
    expect(
      refuseMemoryEdit(agent, agentScope("ceo"), { ...edit, kind: "prompt" }, undefined),
    ).toMatch(/cannot write prompt/);
  });

  it("lets the scanner write the handbook but not over the owner", () => {
    const scanner: MemoryActor = { kind: "scanner" };
    expect(refuseMemoryEdit(scanner, COMPANY_SCOPE, edit, undefined)).toBeUndefined();
    expect(refuseMemoryEdit(scanner, COMPANY_SCOPE, edit, locked)).toMatch(/only the owner/);
    expect(refuseMemoryEdit(scanner, COMPANY_SCOPE, { ...edit, kind: "skill" }, undefined)).toMatch(
      /cannot write skill/,
    );
  });

  it("refuses in the store, not just the check", async () => {
    const memory = memoryFor();
    const result = await memory.apply({
      scope: COMPANY_SCOPE,
      actor: { kind: "dream", id: "ceo" },
      edits: [edit],
    });
    expect(result.change).toBeUndefined();
    expect(result.edits[0]?.applied).toBe(false);
    expect(await memory.list(COMPANY_SCOPE)).toHaveLength(0);
  });
});

describe("memory tools", () => {
  it("remember, recall and forget work on the agent's own memory", async () => {
    const memory = memoryFor();
    await memory.apply({
      scope: COMPANY_SCOPE,
      actor: OWNER,
      edits: [
        { action: "create", kind: "memory", title: "Owner", content: "Prefers bullet points." },
      ],
    });
    const tools = createMemoryTools({ memory, agentId: "ceo", taskId: "task-9" });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name);
    const saved = await tool("remember")?.execute(
      "1",
      {
        title: "Vendors",
        content: "Acme invoices net 30.",
      },
      undefined,
      undefined,
    );
    expect(saved?.content[0]).toMatchObject({ text: "Saved as [vendors]." });
    const [entry] = await memory.list(agentScope("ceo"));
    expect(entry?.origin).toMatchObject({ kind: "agent", ref: "task-9" });

    const found = await tool("recall")?.execute(
      "2",
      { query: "bullet invoices" },
      undefined,
      undefined,
    );
    const text = (found?.content[0] as { text: string }).text;
    expect(text).toContain("handbook");
    expect(text).toContain("Acme");

    await tool("remember")?.execute(
      "3",
      { id: "vendors", title: "Vendors", content: "Acme invoices net 45." },
      undefined,
      undefined,
    );
    expect((await memory.list(agentScope("ceo")))[0]?.content).toBe("Acme invoices net 45.");
    await tool("forget")?.execute("4", { id: "vendors" }, undefined, undefined);
    expect(await memory.list(agentScope("ceo"))).toHaveLength(0);
  });
});
