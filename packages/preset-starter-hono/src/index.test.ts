import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createStarterHonoBootstrapFromYaml,
  createStarterHonoPreset,
  resolveStarterPreset,
  starterHonoPreset,
  starterPresetContract,
} from "./index.js";

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
          "model: gpt-5.2-codex",
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
      expect(bootstrap.runtimePlan.primaryAgent.model).toBe("gpt-5.2-codex");
      await expect(bootstrap.startRuntime()).resolves.toEqual({
        status: "started",
        workspaceRoot: path.resolve(root, "app"),
        model: "gpt-5.2-codex",
        instructions: "Keep answers brief.\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
