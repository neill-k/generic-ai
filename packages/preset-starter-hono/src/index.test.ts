import { describe, expect, it } from "vitest";

import { createStarterHonoPreset, starterHonoPreset } from "./index.js";

describe("@generic-ai/preset-starter-hono", () => {
  it("provides the default Hono starter preset", () => {
    expect(starterHonoPreset.id).toBe("@generic-ai/preset-starter-hono");
    expect(starterHonoPreset.transport).toBe("hono");
    expect(starterHonoPreset.capabilities).toContain("transport-hono");
    expect(starterHonoPreset.ports.piBoundary.symbol).toBe("pi");
  });

  it("supports explicit preset overrides", () => {
    const preset = createStarterHonoPreset({
      id: "@generic-ai/preset-starter-hono-custom",
      transport: "hono-custom",
      ports: {
        runMode: {
          status: "provided",
          note: "provided by a custom runtime harness",
        },
      },
    });

    expect(preset.id).toBe("@generic-ai/preset-starter-hono-custom");
    expect(preset.transport).toBe("hono-custom");
    expect(preset.ports.runMode.status).toBe("provided");
  });
});

