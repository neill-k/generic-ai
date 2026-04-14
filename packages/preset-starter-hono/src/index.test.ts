import { describe, expect, it } from "vitest";

import {
  resolveStarterPreset,
  starterPresetContract,
  withStarterPreset,
  type StarterPresetContract,
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

  it("provides a convenience helper that injects the starter contract", () => {
    const fakeBootstrap = (options: { rootScopeId: string; preset: StarterPresetContract }) => options;

    const resolved = withStarterPreset(fakeBootstrap, { rootScopeId: "scope-root" });

    expect(resolved.rootScopeId).toBe("scope-root");
    expect(resolved.preset).toBe(starterPresetContract);
  });
});
