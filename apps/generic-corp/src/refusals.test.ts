import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createRefusalLog } from "./refusals.js";
import { createSqliteStorageContract } from "./storage.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function kv() {
  const dir = mkdtempSync(path.join(tmpdir(), "generic-corp-refusals-"));
  dirs.push(dir);
  return createSqliteStorageContract(createSqliteStorage({ path: path.join(dir, "db.sqlite") }));
}

describe("the refused-actions list", () => {
  it("lists refusals newest first and keeps only the newest", async () => {
    let clock = Date.parse("2026-11-27T00:00:00Z");
    const now = () => {
      clock += 1000;
      return new Date(clock);
    };
    const log = createRefusalLog(kv(), { now, keep: 3 });
    for (const host of ["a.example", "b.example", "c.example", "d.example", "e.example"]) {
      await log.record({
        kind: "network",
        agentId: "ceo",
        category: "network",
        action: `CONNECT ${host}:443`,
        reason: `${host} is not on the network allowlist`,
      });
    }
    // Pruning runs on the first write and every 50th after it, so the list caps reads too.
    const listed = await log.list({ limit: 10 });
    expect(listed.map((entry) => entry.action)).toEqual([
      "CONNECT e.example:443",
      "CONNECT d.example:443",
      "CONNECT c.example:443",
    ]);
    expect(listed[0]?.at).toBe("2026-11-27T00:00:05.000Z");
    expect((await log.list({ limit: 1 })).length).toBe(1);
  });
});
