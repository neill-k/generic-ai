import { createStarterHonoPreset } from "@generic-ai/preset-starter-hono";
import { describe, expect, it } from "vitest";
import {
  createGenericCorpPreset,
  GENERIC_CORP_DISPLAY_NAME,
  GENERIC_CORP_PRESET_ID,
  name,
} from "./index.js";

describe("@generic-ai/app-generic-corp scaffold", () => {
  it("names the app workspace", () => {
    expect(name).toBe("@generic-ai/app-generic-corp");
  });

  it("composes the starter preset under the Generic Corp identity", () => {
    const preset = createGenericCorpPreset();
    const starter = createStarterHonoPreset();

    expect(preset.id).toBe(GENERIC_CORP_PRESET_ID);
    expect(preset.name).toBe(GENERIC_CORP_DISPLAY_NAME);
    expect(preset.transport).toBe("hono");
    expect(preset.packageName).toBe("@generic-ai/preset-starter-hono");
    expect(preset.plugins.map((plugin) => plugin.pluginId)).toEqual(
      starter.plugins.map((plugin) => plugin.pluginId),
    );
    expect(preset.capabilities).toEqual(starter.capabilities);
  });

  it("keeps starter preset overrides available to the app", () => {
    const preset = createGenericCorpPreset({ id: "app.generic-corp.test", name: "Test Corp" });

    expect(preset.id).toBe("app.generic-corp.test");
    expect(preset.name).toBe("Test Corp");
  });
});
