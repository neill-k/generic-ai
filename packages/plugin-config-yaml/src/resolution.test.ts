import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCanonicalConfig } from "./resolution.js";

describe("resolveCanonicalConfig", () => {
  it("loads harness YAML concerns alongside agents and plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-config-"));
    await mkdir(join(root, ".generic-ai", "agents"), { recursive: true });
    await mkdir(join(root, ".generic-ai", "harnesses"), { recursive: true });
    await mkdir(join(root, ".generic-ai", "plugins"), { recursive: true });
    await writeFile(
      join(root, ".generic-ai", "framework.yaml"),
      ["schemaVersion: v1", "primaryAgent: starter", "primaryHarness: default"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, ".generic-ai", "harnesses", "default.yaml"),
      ["adapter: pi", "model: gpt-5.5", "policyProfile: local-dev-full"].join("\n"),
      "utf8",
    );

    const result = await resolveCanonicalConfig(root);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.framework["primaryHarness"]).toBe("default");
    expect(result.config.harnesses["default"]).toMatchObject({
      id: "default",
      adapter: "pi",
      model: "gpt-5.5",
      policyProfile: "local-dev-full",
    });
    expect(result.config.sources.harnesses["default"]).toContain("default.yaml");
  });
});
