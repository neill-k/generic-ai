import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createGenericAI,
  createGenericAIFromConfig,
  createStarterPreset,
  starterPreset,
} from "./index.js";

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

  it("builds config-aware runtime plans on top of the current runtime bootstrap", async () => {
    const bootstrap = await createGenericAIFromConfig({
      config: {
        rootDir: "C:/workspace",
        configDir: "C:/workspace/.generic-ai",
        framework: {
          name: "Configured bootstrap",
          preset: "@generic-ai/preset-starter-hono",
          primaryAgent: "starter",
          runtime: {
            workspaceRoot: "apps/demo",
          },
        },
        agents: {
          starter: {
            id: "starter",
            model: "gpt-5.2-codex",
            instructions: "Be concise.",
            tools: ["read"],
            plugins: [],
          },
        },
        plugins: {
          hono: {
            plugin: "@generic-ai/plugin-hono",
            config: {
              routePrefix: "/starter",
            },
          },
        },
      },
      startRuntime: async (input) => ({
        status: "started" as const,
        workspaceRoot: input.runtimePlan.runtime.workspaceRoot,
      }),
    });

    expect(bootstrap.preset.name).toBe("Configured bootstrap");
    expect(bootstrap.runtimePlan.runtime.workspaceRoot).toBe(path.resolve("C:/workspace", "apps/demo"));
    expect(bootstrap.runtimePlan.primaryAgent.model).toBe("gpt-5.2-codex");
    expect(bootstrap.surfaces.pluginConfigs["@generic-ai/plugin-hono"]).toMatchObject({
      namespace: "hono",
      routePrefix: "/starter",
    });
    await expect(bootstrap.startRuntime()).resolves.toEqual({
      status: "started",
      workspaceRoot: path.resolve("C:/workspace", "apps/demo"),
    });
  });
});
