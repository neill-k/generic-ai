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
    expect(bootstrap.pluginHost).toBe(bootstrap.surfaces.pluginHost);
    expect(bootstrap.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "@generic-ai/plugin-config-yaml",
      "@generic-ai/plugin-workspace-fs",
      "@generic-ai/plugin-storage-sqlite",
      "@generic-ai/plugin-queue-memory",
      "@generic-ai/plugin-logging-otel",
      "@generic-ai/plugin-tools-terminal",
      "@generic-ai/plugin-tools-files",
      "@generic-ai/plugin-mcp",
      "@generic-ai/plugin-agent-skills",
      "@generic-ai/plugin-delegation",
      "@generic-ai/plugin-messaging",
      "@generic-ai/plugin-memory-files",
      "@generic-ai/plugin-output-default",
      "@generic-ai/plugin-hono",
    ]);
    expect(bootstrap.surfaces.pluginOrder).toEqual(
      bootstrap.plugins.map((plugin) => plugin.pluginId),
    );
  });

  it("accepts explicit preset and port overrides", () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@generic-ai/preset-custom",
        name: "Custom bootstrap",
        transport: "custom",
        capabilities: ["workspace", "storage"],
        plugins: [
          {
            pluginId: "@acme/plugin-storage",
            slot: "storage",
            required: true,
            config: { namespace: "acme" },
          },
        ],
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
    expect(bootstrap.plugins.map((plugin) => plugin.pluginId)).toEqual(["@acme/plugin-storage"]);
    expect(bootstrap.plugins[0]?.config).toEqual({
      namespace: "acme",
      required: true,
      slot: "storage",
      source: "custom",
    });
    expect(bootstrap.describe()).toContain("Custom bootstrap");
  });

  it("uses plugin-host dependency ordering as the startup source of truth", () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@acme/preset",
        name: "Reordered preset",
        transport: "custom",
        capabilities: [],
        plugins: [
          {
            pluginId: "consumer",
            dependencies: ["provider"],
          },
          {
            pluginId: "provider",
          },
        ],
      }),
    });

    expect(bootstrap.plugins.map((plugin) => plugin.pluginId)).toEqual(["provider", "consumer"]);
    expect(bootstrap.surfaces.pluginOrder).toEqual(["provider", "consumer"]);
  });

  it("runs lifecycle hooks in plugin-host order before executing tasks", async () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@acme/preset",
        name: "Runtime preset",
        transport: "custom",
        capabilities: [],
        plugins: [
          {
            pluginId: "consumer",
            dependencies: ["provider"],
          },
          {
            pluginId: "provider",
          },
        ],
      }),
      createRunId: () => "run-001",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const envelope = await bootstrap.run(({ surfaces }) => ({
      order: surfaces.pluginOrder,
      lifecycle: surfaces.lifecycle.events().map((event) => `${event.pluginId}:${event.phase}`),
    }));

    expect(envelope.status).toBe("succeeded");
    expect(envelope.outputPluginId).toBe("@generic-ai/plugin-output-default");
    expect(envelope.output?.payload).toEqual({
      order: ["provider", "consumer"],
      lifecycle: ["provider:setup", "consumer:setup", "provider:start", "consumer:start"],
    });
  });

  it("streams canonical run events and a terminal envelope", async () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@acme/preset",
        name: "Streaming preset",
        transport: "custom",
        capabilities: [],
        plugins: [{ pluginId: "provider", slot: "output" }],
      }),
      createRunId: () => "run-002",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const chunks = [];
    for await (const chunk of bootstrap.stream("hello")) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(["event", "event", "event", "envelope"]);
    expect(chunks[0]?.type === "event" ? chunks[0].event.name : undefined).toBe("run.created");
    expect(chunks[1]?.type === "event" ? chunks[1].event.name : undefined).toBe("run.started");
    expect(chunks[2]?.type === "event" ? chunks[2].event.name : undefined).toBe("run.completed");
    expect(chunks[3]?.type === "envelope" ? chunks[3].envelope.status : undefined).toBe(
      "succeeded",
    );
    expect(chunks[3]?.type === "envelope" ? chunks[3].envelope.outputPluginId : undefined).toBe(
      "provider",
    );
  });

  it("stops the runtime lifecycle via stop()", async () => {
    const bootstrap = createGenericAI({
      preset: createStarterPreset({
        id: "@acme/preset",
        name: "Stoppable preset",
        transport: "custom",
        capabilities: [],
        plugins: [{ pluginId: "provider" }, { pluginId: "consumer", dependencies: ["provider"] }],
      }),
      now: () => "2026-01-01T00:00:00.000Z",
    });

    await bootstrap.run("hello");
    await bootstrap.stop();

    const events = bootstrap.surfaces.lifecycle.events();
    const stopEvents = events.filter((e) => e.phase === "stop");
    expect(stopEvents).toHaveLength(2);
    expect(stopEvents.map((e) => e.pluginId)).toEqual(["consumer", "provider"]);
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
