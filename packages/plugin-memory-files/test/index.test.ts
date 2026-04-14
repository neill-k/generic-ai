import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore, kind, name } from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-memory-files-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-memory-files", () => {
  it("persists per-agent memories on disk and supports search", async () => {
    await withTempRoot(async (root) => {
      const memory = createFileMemoryStore({
        root,
        now: (() => {
          let timestamp = 1000;
          return () => ++timestamp;
        })(),
        idFactory: (() => {
          let counter = 0;
          return () => `memory-${++counter}`;
        })(),
      });

      const stored = await memory.remember("coordinator", {
        text: "Remember MCP, skills, and messaging for the demo.",
        tags: ["demo", "starter"],
      });

      expect(memory.name).toBe(name);
      expect(memory.kind).toBe(kind);
      expect(await memory.get("coordinator", stored.id)).toEqual(stored);
      expect(await memory.search("coordinator", "skills messaging")).toEqual([
        {
          entry: stored,
          score: 2,
          matches: ["skills", "messaging"],
        },
      ]);

      const rehydrated = createFileMemoryStore({ root });
      expect(await rehydrated.list("coordinator")).toEqual([stored]);
      expect(await rehydrated.forget("coordinator", stored.id)).toBe(true);
      expect(await rehydrated.list("coordinator")).toEqual([]);
    });
  });
});
