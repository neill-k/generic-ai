import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";
import { describe, expect, it } from "vitest";
import { type CompanyConfig, DEFAULT_QUALITY_MODELS, parseCompanyConfig } from "./company.js";
import { describeQuality, openQualityStore, parseQualityLevel, QualityError } from "./quality.js";
import { createSqliteStorageContract } from "./storage.js";

const COMPANY: CompanyConfig = {
  name: "Test Corp",
  models: { ceo: "anthropic/claude-opus-5-5", vp: "openai/gpt-6" },
  agents: [
    { id: "ceo", role: "ceo" },
    { id: "vp", role: "vp", reportsTo: "ceo" },
    { id: "ic", role: "ic", reportsTo: "vp" },
  ],
};

function kv() {
  return createSqliteStorageContract(createSqliteStorage({ path: ":memory:" }));
}

describe("quality dial", () => {
  it("uses the company file's model until the owner picks a step", async () => {
    const storage = kv();
    const store = await openQualityStore(storage, COMPANY);
    expect(store.modelFor("ceo")).toBe("anthropic/claude-opus-5-5");
    expect(store.view("ceo")).toMatchObject({ defaultLevel: "best" });
    expect(store.view("vp").defaultLevel).toBeUndefined();

    const set = await store.set("ceo", "cheap", "owner");
    expect(set).toMatchObject({ level: "cheap", model: DEFAULT_QUALITY_MODELS.cheap });
    expect(store.modelFor("ceo")).toBe(DEFAULT_QUALITY_MODELS.cheap);

    // The setting outlives a restart, and clearing it brings back the company file's model.
    const reopened = await openQualityStore(storage, COMPANY);
    expect(reopened.levelOf("ceo")).toBe("cheap");
    await reopened.set("ceo", undefined);
    expect(reopened.modelFor("ceo")).toBe("anthropic/claude-opus-5-5");
    expect((await openQualityStore(storage, COMPANY)).levelOf("ceo")).toBeUndefined();
  });

  it("takes the step models from the company file", async () => {
    const company = { ...COMPANY, qualityModels: { cheap: "openai/gpt-6-mini" } };
    const store = await openQualityStore(kv(), company);
    await store.set("ic", "cheap");
    expect(store.modelFor("ic")).toBe("openai/gpt-6-mini");
    expect(describeQuality(store, company).levels).toEqual([
      { level: "best", model: DEFAULT_QUALITY_MODELS.best },
      { level: "balanced", model: DEFAULT_QUALITY_MODELS.balanced },
      { level: "cheap", model: "openai/gpt-6-mini" },
    ]);
  });

  it("rejects unknown agents, steps and config", async () => {
    const store = await openQualityStore(kv(), COMPANY);
    await expect(store.set("nobody", "best")).rejects.toThrow(QualityError);
    expect(() => parseQualityLevel("turbo")).toThrow(QualityError);
    expect(parseQualityLevel("default")).toBeUndefined();
    expect(parseQualityLevel(null)).toBeUndefined();
    expect(() =>
      parseCompanyConfig({ agents: [{ id: "ceo" }], qualityModels: { turbo: "x/y" } }),
    ).toThrow(/not a quality step/);
    expect(
      parseCompanyConfig({ agents: [{ id: "ceo" }], qualityModels: { best: "x/y" } }).qualityModels,
    ).toEqual({ best: "x/y" });
  });
});
