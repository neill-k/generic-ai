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
    expect(starterPresetContract.slots).toHaveLength(14);
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
        ".generic-ai/agents/primary.yaml": `model: gpt-5
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
          model: "gpt-5",
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
