import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverCanonicalConfig } from "./discovery.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

function fixtureRoot(name: string): string {
  return resolve(currentDir, "fixtures", name);
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

describe("discoverCanonicalConfig", () => {
  it("discovers fixed-layout files with deterministic order from nested directories", async () => {
    const startDir = resolve(fixtureRoot("canonical"), "workspace", "child");
    const result = await discoverCanonicalConfig(startDir);

    expect(result.failures).toEqual([]);
    expect(result.rootDir).toBe(fixtureRoot("canonical"));
    expect(toPosixPath(result.frameworkFile?.relativePath ?? "")).toBe(
      ".generic-ai/framework.yaml",
    );
    expect(result.agentFiles.map((entry) => entry.key)).toEqual(["implementer", "research"]);
    expect(result.pluginFiles.map((entry) => entry.key)).toEqual(["output", "storage"]);
    expect(result.files.map((entry) => toPosixPath(entry.relativePath))).toEqual([
      ".generic-ai/framework.yaml",
      ".generic-ai/agents/implementer.yml",
      ".generic-ai/agents/research.yaml",
      ".generic-ai/plugins/output.yaml",
      ".generic-ai/plugins/storage.yml",
    ]);
  });

  it("reports duplicate concern files with key and candidate paths", async () => {
    const result = await discoverCanonicalConfig(fixtureRoot("duplicates"));
    const duplicate = result.failures.find((failure) => failure.code === "DUPLICATE_CONCERN_FILE");

    expect(duplicate).toBeDefined();
    expect(duplicate?.concern).toBe("plugin");
    expect(duplicate?.key).toBe("storage");
    expect(duplicate?.paths?.length).toBe(2);
    expect(duplicate?.suggestion).toContain("Keep a single file");
  });

  it("discovers singleton lifecycle hook config next to framework.yaml", async () => {
    const result = await discoverCanonicalConfig(fixtureRoot("hooks"));

    expect(result.failures).toEqual([]);
    expect(result.hooksFile?.key).toBe("hooks");
    expect(toPosixPath(result.hooksFile?.relativePath ?? "")).toBe(".generic-ai/hooks.yaml");
    expect(result.files.map((entry) => toPosixPath(entry.relativePath))).toEqual([
      ".generic-ai/framework.yaml",
      ".generic-ai/hooks.yaml",
    ]);
  });
});
