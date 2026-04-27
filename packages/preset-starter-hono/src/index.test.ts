import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GenericAIConfigError } from "@generic-ai/core";
import {
  PluginSchemaRegistry,
  type ZodIssueLike,
  type ZodSchemaLike,
} from "@generic-ai/plugin-config-yaml";
import { describe, expect, it } from "vitest";
import {
  createStarterHonoBootstrapFromYaml,
  createStarterHonoPreset,
  resolveStarterPreset,
  STARTER_SANDBOX_TERMINAL_PLUGIN_ID,
  STARTER_TERMINAL_PLUGIN_ID,
  starterHonoPreset,
  starterPresetContract,
} from "./index.js";

async function withConfigRoot<T>(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "preset-starter-hono-config-"));

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf8");
    }

    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("@generic-ai/preset-starter-hono contract", () => {
  it("resolves the default plugin stack in canonical order", () => {
    const resolved = resolveStarterPreset();
    const pluginIds = resolved.plugins.map((plugin) => plugin.pluginId);

    expect(pluginIds).toEqual([
      "@generic-ai/plugin-config-yaml",
      "@generic-ai/plugin-workspace-fs",
      "@generic-ai/plugin-storage-sqlite",
      "@generic-ai/plugin-queue-memory",
      "@generic-ai/plugin-logging-otel",
      "@generic-ai/plugin-tools-terminal",
      "@generic-ai/plugin-tools-files",
      "@generic-ai/plugin-repo-map",
      "@generic-ai/plugin-lsp",
      "@generic-ai/plugin-mcp",
      "@generic-ai/plugin-agent-skills",
      "@generic-ai/plugin-delegation",
      "@generic-ai/plugin-messaging",
      "@generic-ai/plugin-memory-files",
      "@generic-ai/plugin-output-default",
      "@generic-ai/plugin-hono",
    ]);
    expect(resolved.includesHono).toBe(true);
  });

  it("supports overriding a slot with a custom plugin", () => {
    const resolved = resolveStarterPreset({
      slotOverrides: [{ slot: "storage", pluginId: "@acme/plugin-storage-postgres" }],
    });
    const pluginIds = resolved.plugins.map((plugin) => plugin.pluginId);

    expect(pluginIds).toContain("@acme/plugin-storage-postgres");
    expect(pluginIds).not.toContain("@generic-ai/plugin-storage-sqlite");
  });

  it("switches the terminal slot to the sandbox plugin when sandbox mode is docker", () => {
    const preset = createStarterHonoPreset({
      sandboxMode: "docker",
    });

    expect(preset.sandboxMode).toBe("docker");
    expect(preset.resolution.sandboxMode).toBe("docker");
    expect(preset.resolution.terminalPluginId).toBe(STARTER_SANDBOX_TERMINAL_PLUGIN_ID);
    expect(preset.plugins.find((plugin) => plugin.slot === "terminalTools")).toMatchObject({
      pluginId: STARTER_SANDBOX_TERMINAL_PLUGIN_ID,
      dependencies: ["@generic-ai/plugin-workspace-fs"],
    });
  });

  it("supports swapping the terminal slot to the sandbox plugin", async () => {
    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: sandbox migration
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: root,
          slotOverrides: [
            {
              slot: "terminalTools",
              pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
              description: "Docker-backed sandbox terminal execution.",
            },
          ],
        });

        expect(
          bootstrap.preset.plugins.find((plugin) => plugin.slot === "terminalTools"),
        ).toMatchObject({
          pluginId: "@generic-ai/plugin-tools-terminal-sandbox",
          dependencies: ["@generic-ai/plugin-workspace-fs"],
        });
      },
    );
  });

  it("supports disabling optional Hono transport", () => {
    const resolved = resolveStarterPreset({
      slotOverrides: [{ slot: "transport", enabled: false }],
    });
    const pluginIds = resolved.plugins.map((plugin) => plugin.pluginId);

    expect(pluginIds).not.toContain("@generic-ai/plugin-hono");
    expect(resolved.includesHono).toBe(false);
  });

  it("inserts addon plugins deterministically around an anchor slot", () => {
    const resolved = resolveStarterPreset({
      addons: [
        { pluginId: "@acme/plugin-before-a", anchorSlot: "output", insert: "before" },
        { pluginId: "@acme/plugin-before-b", anchorSlot: "output", insert: "before" },
        { pluginId: "@acme/plugin-after", anchorSlot: "output", insert: "after" },
      ],
    });
    const pluginIds = resolved.plugins.map((plugin) => plugin.pluginId);
    const outputIndex = pluginIds.indexOf("@generic-ai/plugin-output-default");

    expect(outputIndex).toBeGreaterThan(1);
    expect(pluginIds[outputIndex - 2]).toBe("@acme/plugin-before-a");
    expect(pluginIds[outputIndex - 1]).toBe("@acme/plugin-before-b");
    expect(pluginIds[outputIndex + 1]).toBe("@acme/plugin-after");
  });

  it("throws when trying to disable a required slot", () => {
    expect(() =>
      resolveStarterPreset({
        slotOverrides: [{ slot: "storage", enabled: false }],
      }),
    ).toThrow('Slot "storage" is required and cannot be disabled.');
  });

  it("exports the starter preset contract", () => {
    expect(starterPresetContract.id).toBe("preset.starter-hono");
    expect(starterPresetContract.version).toBe(1);
    expect(starterPresetContract.slots).toHaveLength(16);
  });

  it("builds a bootstrap-ready starter preset definition", () => {
    const preset = createStarterHonoPreset({
      slotOverrides: [{ slot: "transport", enabled: false }],
    });

    expect(starterHonoPreset.transport).toBe("hono");
    expect(preset.transport).toBe("custom");
    expect(preset.capabilities).not.toContain("transport-hono");
    expect(preset.resolution.includesHono).toBe(false);
    expect(preset.packageName).toBe("@generic-ai/preset-starter-hono");
    expect(preset.plugins.map((plugin) => plugin.pluginId)).not.toContain(
      "@generic-ai/plugin-hono",
    );
    expect(
      preset.plugins.find((plugin) => plugin.pluginId === "@generic-ai/plugin-tools-files")
        ?.dependencies,
    ).toEqual(["@generic-ai/plugin-workspace-fs"]);
  });

  it("loads canonical yaml and exposes a configured bootstrap helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starter-hono-preset-"));

    try {
      await mkdir(path.join(root, ".generic-ai", "agents"), { recursive: true });
      await writeFile(
        path.join(root, ".generic-ai", "framework.yaml"),
        [
          "schemaVersion: v1",
          "name: YAML starter",
          'preset: "@generic-ai/preset-starter-hono"',
          "primaryAgent: starter",
          "runtime:",
          "  workspaceRoot: app",
        ].join("\n"),
      );
      await writeFile(
        path.join(root, ".generic-ai", "agents", "starter.yaml"),
        [
          "displayName: Starter",
          "model: gpt-5.5",
          "instructions: |",
          "  Keep answers brief.",
          "tools: []",
          "plugins: []",
        ].join("\n"),
      );

      const bootstrap = await createStarterHonoBootstrapFromYaml({
        startDir: root,
        startRuntime: async (input) => ({
          status: "started" as const,
          workspaceRoot: input.runtimePlan.runtime.workspaceRoot,
          model: input.runtimePlan.primaryAgent.model,
          instructions: input.runtimePlan.primaryAgent.instructions,
        }),
      });

      expect(bootstrap.runtimePlan.runtime.workspaceRoot).toBe(path.resolve(root, "app"));
      expect(bootstrap.runtimePlan.primaryAgent.model).toBe("gpt-5.5");
      await expect(bootstrap.startRuntime()).resolves.toEqual({
        status: "started",
        workspaceRoot: path.resolve(root, "app"),
        model: "gpt-5.5",
        instructions: "Keep answers brief.\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads canonical YAML through the config plugin before producing a runtime plan", async () => {
    const registry = new PluginSchemaRegistry().register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        kind: "string",
        path: "string",
      }),
      source: "storage-config",
    });

    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: yaml starter
primaryAgent: primary
runtime:
  workspaceRoot: workspace
  storage:
    provider: "@generic-ai/plugin-storage-sqlite"
  queue:
    provider: "@generic-ai/plugin-queue-memory"
  logging:
    level: info
`,
        ".generic-ai/agents/primary.yaml": `model: gpt-5.5
instructions: "Use the configured starter stack."
tools:
  - files.read
plugins:
  - storage
memory:
  provider: "@generic-ai/plugin-memory-files"
  path: ".generic-ai/memory"
`,
        ".generic-ai/plugins/storage.yaml": `plugin: "@generic-ai/plugin-storage-sqlite"
kind: sqlite
path: ".generic-ai/storage.db"
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: path.join(root, "workspace"),
          schemaSource: registry,
        });

        expect(bootstrap.preset.id).toBe("@generic-ai/preset-starter-hono");
        expect(bootstrap.runtimePlan.runtime).toMatchObject({
          workspaceRoot: path.join(root, "workspace"),
          storageProvider: "@generic-ai/plugin-storage-sqlite",
          queueProvider: "@generic-ai/plugin-queue-memory",
          loggingLevel: "info",
        });
        expect(bootstrap.runtimePlan.primaryAgent).toMatchObject({
          id: "primary",
          model: "gpt-5.5",
          instructions: "Use the configured starter stack.",
          tools: ["files.read"],
          plugins: ["storage"],
        });
        expect(
          bootstrap.runtimePlan.plugins.find((plugin) => plugin.namespace === "storage"),
        ).toMatchObject({
          pluginId: "@generic-ai/plugin-storage-sqlite",
          config: {
            kind: "sqlite",
            path: ".generic-ai/storage.db",
          },
        });
      },
    );
  });

  it("surfaces plugin schema violations before runtime start", async () => {
    const registry = new PluginSchemaRegistry().register({
      pluginId: "@generic-ai/plugin-storage-sqlite",
      namespace: "storage",
      schema: objectSchema({
        kind: "string",
      }),
    });
    const startCalls: unknown[] = [];

    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: invalid storage
`,
        ".generic-ai/plugins/storage.yaml": `plugin: "@generic-ai/plugin-storage-sqlite"
kind: 42
`,
      },
      async (root) => {
        await expect(
          createStarterHonoBootstrapFromYaml({
            startDir: root,
            schemaSource: registry,
            startRuntime: (input) => {
              startCalls.push(input);
              return {
                status: "started" as const,
              };
            },
          }),
        ).rejects.toThrow(GenericAIConfigError);
      },
    );

    expect(startCalls).toEqual([]);
  });

  it("keeps unrestricted terminal mode when sandbox mode is explicitly disabled", async () => {
    let dockerProbeCalls = 0;

    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: sandbox disabled
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: root,
          sandboxMode: "none",
          sandbox: {
            dockerProbe: async () => {
              dockerProbeCalls += 1;
              return true;
            },
          },
        });

        expect(
          bootstrap.preset.plugins.find((plugin) => plugin.slot === "terminalTools"),
        ).toMatchObject({
          pluginId: STARTER_TERMINAL_PLUGIN_ID,
          dependencies: ["@generic-ai/plugin-workspace-fs"],
        });
      },
    );

    expect(dockerProbeCalls).toBe(0);
  });

  it("enables sandbox terminal mode when Docker is available", async () => {
    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: sandbox enabled
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: root,
          sandboxMode: "docker",
          sandbox: {
            dockerProbe: async () => true,
          },
        });

        expect(
          bootstrap.preset.plugins.find((plugin) => plugin.slot === "terminalTools"),
        ).toMatchObject({
          pluginId: STARTER_SANDBOX_TERMINAL_PLUGIN_ID,
          dependencies: ["@generic-ai/plugin-workspace-fs"],
        });
      },
    );
  });

  it("warns and falls back to unrestricted terminal mode when Docker is unavailable", async () => {
    const warnings: string[] = [];

    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: docker unavailable
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: root,
          sandbox: {
            env: {
              NODE_ENV: "production",
            },
            dockerProbe: async () => false,
            warn: (message) => warnings.push(message),
          },
        });

        expect(
          bootstrap.preset.plugins.find((plugin) => plugin.slot === "terminalTools"),
        ).toMatchObject({
          pluginId: STARTER_TERMINAL_PLUGIN_ID,
          dependencies: ["@generic-ai/plugin-workspace-fs"],
        });
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Docker is unavailable");
    expect(warnings[0]).toContain(STARTER_TERMINAL_PLUGIN_ID);
  });

  it("honors a caller terminalTools override when sandbox mode came from production default", async () => {
    const warnings: string[] = [];
    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: default sandbox with override
`,
      },
      async (root) => {
        const bootstrap = await createStarterHonoBootstrapFromYaml({
          startDir: root,
          slotOverrides: [
            {
              slot: "terminalTools",
              pluginId: "@acme/custom-terminal",
              description: "Custom terminal plugin pinned by config.",
            },
          ],
          sandbox: {
            env: {
              NODE_ENV: "production",
            },
            dockerProbe: async () => true,
            warn: (message) => warnings.push(message),
          },
        });

        const terminalPlugin = bootstrap.preset.plugins.find(
          (plugin) => plugin.slot === "terminalTools",
        );
        expect(terminalPlugin?.pluginId).toBe("@acme/custom-terminal");
      },
    );

    expect(warnings.some((warning) => warning.includes("caller-overridden"))).toBe(true);
  });

  it("throws when caller explicitly opts into sandbox AND sets a terminalTools override", () => {
    expect(() =>
      resolveStarterPreset({
        sandboxMode: "docker",
        sandboxSource: "explicit",
        slotOverrides: [
          {
            slot: "terminalTools",
            pluginId: "@acme/custom-terminal",
          },
        ],
      }),
    ).toThrow(/sandboxMode cannot be combined with a "terminalTools" slot override/);
  });

  it("fails hard when Docker is unavailable and fail-hard fallback is requested", async () => {
    await withConfigRoot(
      {
        ".generic-ai/framework.yaml": `name: docker required
`,
      },
      async (root) => {
        await expect(
          createStarterHonoBootstrapFromYaml({
            startDir: root,
            sandboxMode: "docker",
            sandbox: {
              fallbackMode: "fail",
              dockerProbe: async () => false,
            },
          }),
        ).rejects.toThrow("Docker is unavailable");
      },
    );
  });
});

function objectSchema(spec: Record<string, "boolean" | "string">): ZodSchemaLike<unknown> {
  return {
    safeParse(input: unknown) {
      if (!isRecord(input)) {
        return {
          success: false,
          error: {
            issues: [
              {
                code: "invalid_type",
                message: "Expected object.",
                path: [],
              },
            ],
          },
        };
      }

      const issues: ZodIssueLike[] = [];
      for (const [fieldName, expectedType] of Object.entries(spec)) {
        if (typeof input[fieldName] !== expectedType) {
          issues.push({
            code: "invalid_type",
            message: `Expected "${fieldName}" to be ${expectedType}.`,
            path: [fieldName],
          });
        }
      }

      if (issues.length > 0) {
        return {
          success: false,
          error: {
            issues,
          },
        };
      }

      return {
        success: true,
        data: input,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
