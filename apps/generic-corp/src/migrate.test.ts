import type { PostgresStorage } from "@generic-ai/plugin-storage-postgres";
import { describe, expect, it, vi } from "vitest";

import { runMigrations } from "./migrate.js";

function fakeStorage(applied: readonly number[], version: number) {
  const close = vi.fn(async () => undefined);
  const migrate = vi.fn(async () => ({ from: version - applied.length, to: version, applied }));
  const storage = {
    migrate,
    schemaVersion: async () => version,
    close,
  } as unknown as PostgresStorage;
  return { storage, close, migrate };
}

describe("runMigrations", () => {
  it("skips when DATABASE_URL is not set", async () => {
    const open = vi.fn();
    const lines: string[] = [];
    const result = await runMigrations({ env: {}, open, log: (line) => lines.push(line) });

    expect(result).toEqual({ status: "skipped" });
    expect(open).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("DATABASE_URL is not set");
  });

  it("applies pending migrations and closes the connection", async () => {
    const fake = fakeStorage([1, 2, 3], 3);
    const open = vi.fn(async () => fake.storage);
    const lines: string[] = [];
    const result = await runMigrations({
      env: { DATABASE_URL: " postgres://db/app " },
      open,
      log: (line) => lines.push(line),
    });

    expect(open).toHaveBeenCalledWith("postgres://db/app");
    expect(result).toEqual({ status: "migrated", schemaVersion: 3, applied: [1, 2, 3] });
    expect(lines).toEqual(["Applied migrations 1, 2, 3. Postgres schema is at version 3."]);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("reports an up-to-date schema", async () => {
    const fake = fakeStorage([], 4);
    const lines: string[] = [];
    await runMigrations({
      env: { DATABASE_URL: "postgres://db/app" },
      open: async () => fake.storage,
      log: (line) => lines.push(line),
    });

    expect(lines).toEqual(["Postgres schema is up to date at version 4."]);
  });

  it("closes the connection when a migration fails", async () => {
    const fake = fakeStorage([], 1);
    fake.migrate.mockRejectedValueOnce(new Error("lock timeout"));

    await expect(
      runMigrations({
        env: { DATABASE_URL: "postgres://db/app" },
        open: async () => fake.storage,
        log: () => undefined,
      }),
    ).rejects.toThrow("lock timeout");
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
