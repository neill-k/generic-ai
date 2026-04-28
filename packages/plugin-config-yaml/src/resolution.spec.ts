import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCanonicalConfig } from "./resolution.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

function fixtureRoot(name: string): string {
  return resolve(currentDir, "fixtures", name);
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

describe("resolveCanonicalConfig", () => {
  it("resolves framework + concern files into a single config object with provenance", async () => {
    const result = await resolveCanonicalConfig(fixtureRoot("canonical"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected successful resolution.");
    }

    const { implementer, research } = result.config.agents;
    const { output, storage } = result.config.plugins;

    expect(result.config.framework).toMatchObject({
      name: "generic-ai",
      runtime: {
        mode: "local",
        retries: 3,
        tracing: true,
      },
    });
    expect(implementer).toMatchObject({
      model: "gpt-5.5",
      temperature: 0.1,
      maxTokens: 4000,
    });
    expect(research).toMatchObject({
      model: "gpt-5.5",
      temperature: 0.3,
      focus: "architecture",
    });
    expect(output).toMatchObject({
      format: "markdown",
      streaming: true,
    });
    expect(storage).toMatchObject({
      kind: "sqlite",
      path: ".generic-ai/storage.db",
    });
    expect(result.config.sources.order).toEqual([
      resolve(fixtureRoot("canonical"), ".generic-ai/framework.yaml"),
      resolve(fixtureRoot("canonical"), ".generic-ai/agents/implementer.yml"),
      resolve(fixtureRoot("canonical"), ".generic-ai/agents/research.yaml"),
      resolve(fixtureRoot("canonical"), ".generic-ai/plugins/output.yaml"),
      resolve(fixtureRoot("canonical"), ".generic-ai/plugins/storage.yml"),
    ]);
  });

  it("returns actionable syntax diagnostics for malformed YAML", async () => {
    const result = await resolveCanonicalConfig(fixtureRoot("invalid"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected parse failure.");
    }

    const parseFailure = result.failures.find((failure) => failure.code === "CONFIG_PARSE_FAILED");
    expect(parseFailure).toBeDefined();
    expect(toPosixPath(parseFailure?.filePath ?? "")).toContain(".generic-ai/framework.yaml");
    expect(parseFailure?.line).toBeGreaterThanOrEqual(3);
    expect(parseFailure?.concern).toBe("framework");
    expect(parseFailure?.suggestion).toContain("Fix YAML syntax");
  });

  it("requires framework.yaml by default and reports a clear failure when missing", async () => {
    const result = await resolveCanonicalConfig(fixtureRoot("missing-framework"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected missing framework failure.");
    }

    const missingFailure = result.failures.find(
      (failure) => failure.code === "MISSING_FRAMEWORK_CONFIG",
    );
    expect(missingFailure).toBeDefined();
    expect(missingFailure?.concern).toBe("framework");
    expect(missingFailure?.suggestion).toContain(".generic-ai/framework.yaml");
  });

  it("resolves lifecycle hook config with source provenance", async () => {
    const result = await resolveCanonicalConfig(fixtureRoot("hooks"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected hook config resolution.");
    }

    expect(result.config.hooks).toMatchObject({
      schemaVersion: "v1",
      defaults: {
        timeoutMs: 1000,
        failureMode: "fail-closed",
      },
      hooks: [
        {
          id: "inject-context",
          events: ["UserPromptSubmit"],
          handler: {
            type: "command",
            command: "node",
          },
        },
      ],
    });
    expect(toPosixPath(result.config.sources.hooks ?? "")).toContain(".generic-ai/hooks.yaml");
  });
});
