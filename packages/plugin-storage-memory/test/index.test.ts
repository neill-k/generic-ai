import { describe, expect, it } from "vitest";
import {
  MemoryStorageError,
  createMemoryStorage,
  memoryStoragePlugin,
  name,
} from "../src/index.js";

describe("@generic-ai/plugin-storage-memory", () => {
  it("exposes a stable plugin descriptor", () => {
    expect(memoryStoragePlugin).toMatchObject({
      name,
      createStorage: expect.any(Function),
    });
  });

  it("isolates stored values from callers", () => {
    const storage = createMemoryStorage();
    const runs = storage.namespace("runs");
    const input = { nested: { count: 1 } };

    const stored = runs.set("alpha", input);
    input.nested.count = 2;

    expect(stored).toMatchObject({
      key: "alpha",
      version: 1,
    });
    expect(runs.get("alpha")).toEqual({ nested: { count: 1 } });

    const fetched = runs.get<{ nested: { count: number } }>("alpha");
    if (!fetched) {
      throw new Error("Expected a stored value.");
    }

    fetched.nested.count = 9;
    expect(runs.get("alpha")).toEqual({ nested: { count: 1 } });
  });

  it("commits and rolls back transactions atomically", () => {
    const storage = createMemoryStorage();
    storage.namespace("runs").set("stable", { status: "queued" });

    const result = storage.transaction((draft) => {
      const runs = draft.namespace("runs");
      runs.set("beta", { status: "running" });
      return runs.get("beta");
    });

    expect(result).toEqual({ status: "running" });
    expect(storage.namespace("runs").get("beta")).toEqual({ status: "running" });

    expect(() => {
      storage.transaction((draft) => {
        draft.namespace("runs").set("gamma", { status: "failed" });
        throw new Error("boom");
      });
    }).toThrow("boom");

    expect(storage.namespace("runs").has("gamma")).toBe(false);
    expect(storage.namespace("runs").get("stable")).toEqual({
      status: "queued",
    });
  });

  it("restores snapshot metadata and contents", () => {
    let tick = 100;
    const storage = createMemoryStorage({ now: () => tick });
    const runs = storage.namespace("runs");

    expect(runs.set("alpha", { status: "queued" })).toMatchObject({
      createdAt: 100,
      updatedAt: 100,
      version: 1,
    });

    tick = 200;
    expect(runs.set("alpha", { status: "running" })).toMatchObject({
      createdAt: 100,
      updatedAt: 200,
      version: 2,
    });

    const snapshot = storage.snapshot();
    const restored = createMemoryStorage();
    restored.restore(snapshot);

    expect(restored.namespace("runs").list()).toEqual([
      {
        key: "alpha",
        value: { status: "running" },
        version: 2,
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
  });

  it("rejects non-cloneable values", () => {
    const storage = createMemoryStorage();

    expect(() => {
      storage.namespace("runs").set("bad", {
        handler: () => "not cloneable",
      });
    }).toThrow(MemoryStorageError);
  });
});
