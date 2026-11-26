import { describe, expect, it } from "vitest";
import { createGenericAILlmRuntime } from "../../src/runtime/index.js";

describe("@generic-ai/core llm runtime adapter", () => {
  it("uses the native runtime by default", async () => {
    const runtime = await createGenericAILlmRuntime({ model: "gpt-5.5" });
    expect(runtime.adapter).toBe("native");
    expect(runtime.model).toBe("openai/gpt-5.5");
  });

  it("rejects adapters other than native", async () => {
    await expect(
      createGenericAILlmRuntime({ model: "gpt-5.5", adapter: "pi" as unknown as "native" }),
    ).rejects.toThrow(/Unsupported runtime adapter "pi"/);
  });
});
