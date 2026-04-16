import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  GenericAIConfigLoader,
  GenericAIResolvedConfig,
  GenericAIRuntimeStarterInput,
} from "./index.js";
import {
  createGenericAI,
  createGenericAIFromConfig,
  createStarterPreset,
  GenericAIConfigError,
  starterPreset,
} from "./index.js";

const repoRoot = resolve("repo");

function configuredFixture(): GenericAIResolvedConfig {
  return {
    rootDir: repoRoot,
    configDir: resolve(repoRoot, ".generic-ai"),
    framework: {
      name: "yaml-driven project",
      preset: "@generic-ai/preset-starter-hono",
      primaryAgent: "implementer",
      runtime: {
        mode: "local",
        retries: 2,
        tracing: true,
        workspaceRoot: "workspace",
        storage: {
          provider: "@generic-ai/plugin-storage-sqlite",
        },
        queue: {
          provider: "@generic-ai/plugin-queue-memory",
        },
        logging: {
          level: "debug",
        },
      },
    },
    agents: {
      implementer: {
        id: "implementer",
        model: "gpt-5",
        instructions: "Implement the requested change.",
        tools: ["files.read", "terminal.run"],
        plugins: ["storage"],
        memory: {
          provider: "@generic-ai/plugin-memory-files",
          path: ".generic-ai/memory",
        },
      },
    },
    plugins: {
      storage: {
        plugin: "@generic-ai/plugin-storage-sqlite",
        enabled: true,
        kind: "sqlite",
        path: ".generic-ai/storage.db",
      } as unknown as GenericAIResolvedConfig["plugins"][string],
      output: {
        plugin: "@generic-ai/plugin-output-default",
        enabled: false,
        config: {
          format: "markdown",
        },
      },
    },
    sources: {
      framework: resolve(repoRoot, ".generic-ai/framework.yaml"),
      agents: {
        implementer: resolve(repoRoot, ".generic-ai/agents/implementer.yaml"),
      },
      plugins: {
        storage: resolve(repoRoot, ".generic-ai/plugins/storage.yaml"),
      },
      order: [],
    },
  };
}

describe("createGenericAI", () => {
  it("defaults to the starter preset", () => {
    const bootstrap = createGenericAI();

    expect(bootstrap.preset.id).toBe("@generic-ai/preset-starter-hono");
    expect(bootstrap.preset.transport).toBe("hono");
    expect(bootstrap.capabilities).toContain("transport-hono");
    expect(bootstrap.preset.capabilities).toEqual(bootstrap.capabilities);
    expect(bootstrap.preset.ports.pluginHost.symbol).toBe("createPluginHost");
  });

  it("accepts explicit preset and port overrides", () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@generic-ai/preset-custom",
        name: "Custom bootstrap",
        transport: "custom",
        capabilities: ["workspace", "storage"],
      }),
      capabilities: ["workspace"],
      ports: {
        pluginHost: {
          status: "provided",
          note: "wired by a custom harness",
        },
      },
    });

    expect(bootstrap.preset.id).toBe("@generic-ai/preset-custom");
    expect(bootstrap.preset.name).toBe("Custom bootstrap");
    expect(bootstrap.preset.transport).toBe("custom");
    expect(bootstrap.preset.capabilities).toEqual(["workspace"]);
    expect(bootstrap.ports.pluginHost.status).toBe("provided");
    expect(bootstrap.ports.pluginHost.symbol).toBe("createPluginHost");
    expect(bootstrap.describe()).toContain("Custom bootstrap");
  });

  it("keeps the default starter preset frozen and reusable", () => {
    expect(Object.isFrozen(starterPreset)).toBe(true);

    const bootstrap = createGenericAI({ preset: starterPreset });
    expect(bootstrap.preset).not.toBe(starterPreset);
    expect(bootstrap.preset).toEqual(starterPreset);
  });

  it("builds a config-driven runtime plan before runtime start", async () => {
    const config = configuredFixture();
    const schemaSource = { name: "schema-source" } as const;
    const loaderCalls: Array<{
      readonly startDir: string;
      readonly options: unknown;
    }> = [];
    const loader: GenericAIConfigLoader<typeof schemaSource> = async (startDir, options) => {
      loaderCalls.push({ startDir, options });
      return {
        ok: true,
        config,
      };
    };
    let starterInput: GenericAIRuntimeStarterInput | undefined;

    const bootstrap = await createGenericAIFromConfig({
      configSource: {
        startDir: resolve(repoRoot, "workspace", "child"),
        load: loader,
        schemaSource,
        rejectUnknownPluginNamespaces: false,
      },
      startRuntime: (input) => {
        starterInput = input;
        return {
          status: "started" as const,
          model: input.runtimePlan.primaryAgent.model,
        };
      },
    });

    expect(loaderCalls).toHaveLength(1);
    expect(loaderCalls[0]?.options).toMatchObject({
      schemaSource,
      rejectUnknownPluginNamespaces: false,
    });
    expect(bootstrap.preset.id).toBe("@generic-ai/preset-starter-hono");
    expect(bootstrap.runtimePlan.runtime).toMatchObject({
      mode: "local",
      retries: 2,
      tracing: true,
      workspaceRoot: resolve(repoRoot, "workspace"),
      storageProvider: "@generic-ai/plugin-storage-sqlite",
      queueProvider: "@generic-ai/plugin-queue-memory",
      loggingLevel: "debug",
    });
    expect(bootstrap.runtimePlan.primaryAgent).toMatchObject({
      id: "implementer",
      model: "gpt-5",
      instructions: "Implement the requested change.",
      tools: ["files.read", "terminal.run"],
      plugins: ["storage"],
      memory: {
        provider: "@generic-ai/plugin-memory-files",
        path: ".generic-ai/memory",
      },
    });
    expect(
      bootstrap.runtimePlan.plugins.find((plugin) => plugin.namespace === "storage"),
    ).toMatchObject({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      enabled: true,
      config: {
        kind: "sqlite",
        path: ".generic-ai/storage.db",
      },
    });
    expect(
      bootstrap.runtimePlan.plugins.find((plugin) => plugin.namespace === "output"),
    ).toMatchObject({
      enabled: false,
      config: {
        format: "markdown",
      },
    });

    const started = await bootstrap.startRuntime();
    expect(started).toEqual({
      status: "started",
      model: "gpt-5",
    });
    expect(starterInput?.runtimePlan).toBe(bootstrap.runtimePlan);
  });

  it("supports defaults-only resolved config without starting a runtime", async () => {
    const bootstrap = await createGenericAIFromConfig({
      config: {
        rootDir: repoRoot,
        framework: {
          name: "defaults-only",
        },
        agents: {},
        plugins: {},
      },
    });

    expect(bootstrap.runtimePlan.runtime.workspaceRoot).toBe(repoRoot);
    expect(bootstrap.runtimePlan.primaryAgent).toEqual({
      id: "primary",
      tools: [],
      plugins: [],
    });
    expect(await bootstrap.startRuntime()).toEqual({
      status: "planned",
      plan: bootstrap.runtimePlan,
    });
  });

  it("fails config bootstrap before runtime start when YAML validation fails", async () => {
    const startCalls: GenericAIRuntimeStarterInput[] = [];

    await expect(
      createGenericAIFromConfig({
        configSource: {
          startDir: repoRoot,
          load: async () => ({
            ok: false,
            diagnostics: [
              {
                code: "SCHEMA_VALIDATION_FAILED",
                message: "Expected storage.kind to be sqlite.",
                path: "$.plugins.storage.kind",
              },
            ],
          }),
        },
        startRuntime: (input) => {
          startCalls.push(input);
          return {
            status: "started" as const,
          };
        },
      }),
    ).rejects.toThrow(GenericAIConfigError);

    expect(startCalls).toEqual([]);
  });
});
