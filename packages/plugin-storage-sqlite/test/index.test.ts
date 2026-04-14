import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteStorageError,
  createSqliteStorage,
  name,
  sqliteStoragePlugin,
} from "../src/index.js";

const tempRoots: string[] = [];

async function withTempDatabases<T>(
  run: (primaryPath: string, secondaryPath: string) => Promise<T> | T,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-storage-sqlite-"));
  tempRoots.push(root);

  const primaryPath = path.join(root, "primary.sqlite");
  const secondaryPath = path.join(root, "secondary.sqlite");

  try {
    return await run(primaryPath, secondaryPath);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-storage-sqlite", () => {
  it("exposes a stable plugin descriptor", () => {
    expect(sqliteStoragePlugin).toMatchObject({
      name,
      createStorage: expect.any(Function),
    });
  });

  it("persists values across reopen", async () => {
    await withTempDatabases((primaryPath) => {
      const created = createSqliteStorage({ path: primaryPath });
      created.namespace("runs").set("alpha", {
        status: "queued",
        startedAt: new Date(0),
      });
      created.close();

      const reopened = createSqliteStorage({ path: primaryPath });
      expect(reopened.namespaces()).toEqual(["runs"]);
      expect(reopened.namespace("runs").get("alpha")).toEqual({
        status: "queued",
        startedAt: new Date(0),
      });
      reopened.close();
    });
  });

  it("rolls back failed transactions", async () => {
    await withTempDatabases((primaryPath) => {
      const storage = createSqliteStorage({ path: primaryPath });
      storage.namespace("runs").set("stable", {
        status: "queued",
      });

      expect(() => {
        storage.transaction(() => {
          storage.namespace("runs").set("temp", {
            status: "running",
          });
          throw new Error("boom");
        });
      }).toThrow("boom");

      expect(storage.namespace("runs").has("temp")).toBe(false);
      expect(storage.namespace("runs").get("stable")).toEqual({
        status: "queued",
      });
      storage.close();
    });
  });

  it("snapshots and restores data between databases", async () => {
    await withTempDatabases((primaryPath, secondaryPath) => {
      const primary = createSqliteStorage({
        path: primaryPath,
        now: () => 100,
      });
      primary.namespace("runs").set("alpha", {
        status: "queued",
      });
      primary.namespace("agents").set("primary", {
        role: "orchestrator",
      });

      const snapshot = primary.snapshot();
      const secondary = createSqliteStorage({ path: secondaryPath });
      secondary.restore(snapshot);

      expect(secondary.snapshot()).toEqual(snapshot);

      primary.close();
      secondary.close();
    });
  });

  it("rejects non-serializable values", async () => {
    await withTempDatabases((primaryPath) => {
      const storage = createSqliteStorage({ path: primaryPath });

      expect(() => {
        storage.namespace("runs").set("bad", {
          handler: () => "not serializable",
        });
      }).toThrow(SqliteStorageError);

      storage.close();
    });
  });
});
