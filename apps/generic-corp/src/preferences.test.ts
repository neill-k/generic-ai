import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  type BackgroundModel,
  type BackgroundRequest,
  createBackgroundGate,
  createMemoryBackgroundStore,
} from "./background.js";
import { agentScope, COMPANY_SCOPE, createCompanyMemory } from "./memory.js";
import { createPreferenceScanner, type OwnerMessage } from "./preferences.js";
import { createSqliteStorageContract } from "./storage.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function setup(replies: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-prefs-"));
  const sqlite = createSqliteStorage({ path: path.join(directory, "kv.sqlite") });
  cleanups.push(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const kv = createSqliteStorageContract(sqlite);
  const memory = createCompanyMemory({ kv });
  const store = createMemoryBackgroundStore({ kv });
  const requests: BackgroundRequest[] = [];
  const model: BackgroundModel = async (request) => {
    requests.push(request);
    const text = replies.shift();
    if (text === undefined) {
      throw new Error("unexpected model call");
    }
    return { text, totalTokens: 120, costUsd: 0.001 };
  };
  const messages: OwnerMessage[] = [];
  const scanner = createPreferenceScanner({
    memory,
    store,
    model,
    gate: createBackgroundGate({ store }),
    messages: async () => messages,
    agents: async () => [
      { id: "ceo", title: "CEO" },
      { id: "writer", title: "Writer" },
    ],
  });
  return { memory, store, scanner, requests, messages };
}

const message = (id: string, text: string, at: string): OwnerMessage => ({
  messageId: id,
  threadId: "t1",
  text,
  createdAt: at,
  agentId: "ceo",
});

describe("preference scanner (decision 18)", () => {
  it("files company-wide and agent preferences with the message they came from", async () => {
    const { memory, scanner, requests, messages, store } = setup([
      JSON.stringify({
        preferences: [
          {
            scope: "company",
            title: "Short updates",
            content: "The owner wants updates in three bullets or fewer.",
            quote: "keep updates to three bullets",
            messageId: "m1",
          },
          {
            scope: "writer",
            title: "British spelling",
            content: "Write in British English.",
            quote: "the writer should use British spelling",
            messageId: "m2",
          },
          { scope: "nobody", title: "x", content: "y" },
        ],
      }),
    ]);
    messages.push(
      message("m1", "Please keep updates to three bullets from now on.", "2026-11-27T01:00:00Z"),
      message("m2", "Also, the writer should use British spelling.", "2026-11-27T01:01:00Z"),
    );
    const result = await scanner.scan();
    expect(result).toMatchObject({ scanned: 2, filed: 2, refused: 1 });
    expect(requests[0]?.prompt).toContain("[m1] to ceo");

    const [handbook] = await memory.list(COMPANY_SCOPE);
    expect(handbook).toMatchObject({
      kind: "prompt",
      title: "Short updates",
      locked: false,
      origin: { kind: "chat", ref: "thread/t1/message/m1", note: "keep updates to three bullets" },
    });
    const [writer] = await memory.list(agentScope("writer"));
    expect(writer?.title).toBe("British spelling");
    expect(await memory.list(agentScope("ceo"))).toHaveLength(0);

    // Nothing new: no model call.
    expect(await scanner.scan()).toMatchObject({ scanned: 0, skipped: "No new owner messages." });
    expect(requests).toHaveLength(1);
    expect((await store.job("scanner")).usage).toEqual({
      calls: 1,
      totalTokens: 120,
      costUsd: 0.001,
    });
  });

  it("updates an existing preference but never one the owner wrote", async () => {
    const { memory, scanner, messages } = setup([
      JSON.stringify({
        preferences: [
          { scope: "company", id: "tone", title: "Tone", content: "Casual.", messageId: "m1" },
          { scope: "company", id: "mine", title: "Mine", content: "Overwritten.", messageId: "m1" },
        ],
      }),
    ]);
    await memory.apply({
      scope: COMPANY_SCOPE,
      actor: { kind: "scanner" },
      edits: [{ action: "create", kind: "prompt", id: "tone", title: "Tone", content: "Formal." }],
    });
    await memory.apply({
      scope: COMPANY_SCOPE,
      actor: { kind: "owner" },
      edits: [{ action: "create", kind: "prompt", id: "mine", title: "Mine", content: "Keep." }],
    });
    messages.push(message("m1", "Be casual. Also overwrite mine.", "2026-11-27T01:00:00Z"));
    const result = await scanner.scan();
    expect(result).toMatchObject({ filed: 1, refused: 1 });
    const entries = await memory.list(COMPANY_SCOPE);
    expect(entries.find((entry) => entry.id === "tone")?.content).toBe("Casual.");
    expect(entries.find((entry) => entry.id === "mine")?.content).toBe("Keep.");
  });

  it("does nothing while paused, and skips a malformed reply without retrying it", async () => {
    const { scanner, messages, store, requests } = setup(["not json"]);
    messages.push(message("m1", "Hello", "2026-11-27T01:00:00Z"));
    await store.updateSettings({ paused: true });
    expect(await scanner.scan()).toMatchObject({ skipped: "Background memory work is paused." });
    expect(requests).toHaveLength(0);
    await store.updateSettings({ paused: false });
    const result = await scanner.scan();
    expect(result.filed).toBe(0);
    expect(result.skipped).toBeDefined();
    expect(await scanner.scan()).toMatchObject({ skipped: "No new owner messages." });
    expect((await store.job("scanner")).lastError).toBeDefined();
  });

  it("respects a spending gate", async () => {
    const { memory, store, messages } = setup([]);
    const scanner = createPreferenceScanner({
      memory,
      store,
      model: async () => {
        throw new Error("must not be called");
      },
      gate: createBackgroundGate({ store, canSpend: () => "The monthly limit is reached." }),
      messages: async () => messages,
      agents: async () => [],
    });
    messages.push(message("m1", "Hello", "2026-11-27T01:00:00Z"));
    expect(await scanner.scan()).toMatchObject({ skipped: "The monthly limit is reached." });
  });
});
