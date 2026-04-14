import { describe, expect, it } from "vitest";

import {
  createGenericAI,
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
});

