import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { describe, expect, it } from "vitest";

import {
  CompanyConfigError,
  companyAgentSeeds,
  DEFAULT_COMPANY,
  modelFor,
  parseCompanyYaml,
  tierOf,
} from "./company.js";
import { createSqliteStorageContract } from "./storage.js";

describe("company config", () => {
  it("parses YAML with per-tier models and per-agent overrides", () => {
    const company = parseCompanyYaml(`
name: Acme
models:
  ceo: anthropic/claude-opus-5-5
  ic: anthropic/claude-haiku-5-5
agents:
  - id: ceo
    role: ceo
  - id: vp-sales
    role: vp-sales
    reportsTo: ceo
  - id: rep
    role: rep
    reportsTo: vp-sales
  - id: analyst
    role: analyst
    reportsTo: vp-sales
    model: openai/gpt-5.5
`);
    expect(tierOf(company, "ceo")).toBe("ceo");
    expect(tierOf(company, "vp-sales")).toBe("vp");
    expect(tierOf(company, "rep")).toBe("ic");
    expect(modelFor(company, "ceo")).toBe("anthropic/claude-opus-5-5");
    expect(modelFor(company, "vp-sales")).toBe("anthropic/claude-sonnet-5-5");
    expect(modelFor(company, "rep")).toBe("anthropic/claude-haiku-5-5");
    expect(modelFor(company, "analyst")).toBe("openai/gpt-5.5");
    const seeds = companyAgentSeeds(company);
    expect(seeds.find((seed) => seed.id === "rep")).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      roleKind: "builder",
      metadata: { tier: "ic" },
    });
  });

  it("ships a default company that covers more than software work", () => {
    const seeds = companyAgentSeeds(DEFAULT_COMPANY);
    expect(seeds.filter((seed) => seed.reportsTo === undefined).map((seed) => seed.id)).toEqual([
      "ceo",
    ]);
    expect(seeds.map((seed) => seed.id)).toEqual(
      expect.arrayContaining(["vp-research", "vp-operations", "vp-engineering"]),
    );
  });

  it.each([
    ["no agents", "name: X\nagents: []", /at least one agent/],
    ["two CEOs", "agents:\n  - id: a\n  - id: b", /exactly one agent without a manager/],
    ["unknown manager", "agents:\n  - id: a\n  - id: b\n    reportsTo: c", /not in the company/],
    [
      "a loop",
      "agents:\n  - id: root\n  - id: a\n    reportsTo: b\n  - id: b\n    reportsTo: a",
      /loops back/,
    ],
    ["duplicate ids", "agents:\n  - id: a\n  - id: a", /defined twice/],
    ["bad id", "agents:\n  - id: ../etc", /letters, digits/],
    ["bad tier", "agents:\n  - id: a\n    tier: boss", /tier must be/],
    ["bad yaml", "agents: [", /could not be parsed/],
  ])("rejects %s", (_name, yaml, message) => {
    expect(() => parseCompanyYaml(yaml)).toThrow(CompanyConfigError);
    expect(() => parseCompanyYaml(yaml)).toThrow(message);
  });
});

describe("SQLite storage contract", () => {
  it("stores, lists, filters and deletes records by namespace and collection", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-kv-"));
    const sqlite = createSqliteStorage({ path: path.join(directory, "kv.sqlite") });
    try {
      const kv = createSqliteStorageContract(sqlite);
      const at = new Date().toISOString();
      await kv.set({
        key: { namespace: "app", collection: "threads", id: "t1" },
        value: { a: 1 },
        updatedAt: at,
      });
      await kv.set({
        key: { namespace: "app", collection: "threads", id: "t2" },
        value: { a: 2 },
        updatedAt: at,
      });
      await kv.set({
        key: { namespace: "app", collection: "agents", id: "ceo" },
        value: { b: 1 },
        updatedAt: at,
      });
      await kv.set({
        key: { namespace: "other", collection: "threads", id: "t3" },
        value: {},
        updatedAt: at,
      });

      expect((await kv.get({ namespace: "app", collection: "threads", id: "t1" }))?.value).toEqual({
        a: 1,
      });
      expect(await kv.get({ namespace: "app", collection: "threads", id: "nope" })).toBeUndefined();
      expect(
        (await kv.list({ namespace: "app", collection: "threads" })).map((r) => r.key.id).sort(),
      ).toEqual(["t1", "t2"]);
      expect(await kv.list({ namespace: "app", prefix: "t2" })).toHaveLength(1);
      expect(await kv.list()).toHaveLength(4);
      expect(await kv.delete({ namespace: "app", collection: "threads", id: "t1" })).toBe(true);
      await kv.clear({ namespace: "app", collection: "agents" });
      expect((await kv.list({ namespace: "app" })).map((r) => r.key.id)).toEqual(["t2"]);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
