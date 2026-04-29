import { describe, expect, it } from "vitest";

import { createMockRuntimeAdapter } from "../../src/harness/mock-runtime.js";

describe("createMockRuntimeAdapter", () => {
  it("runs without importing pi primitives", async () => {
    const adapter = createMockRuntimeAdapter();
    const result = await adapter.run(
      {
        runId: "run-1",
        harness: { id: "harness.mock", name: "Mock Harness" },
        mission: { id: "mission.mock", title: "Mock Mission" },
      },
      {
        events: { emit: async () => undefined },
        artifacts: {
          write: async () => ({
            uri: "memory:///artifact",
            hash: "hash",
            kind: "json",
            contentType: "application/json",
          }),
        },
        policy: { evaluate: async () => ({ allowed: true, decision: { allowed: true, reason: "ok" } }) },
      },
    );

    expect(result.harnessId).toBe("harness.mock");
    expect(result.adapter).toBe("external");
    expect(result.outputText).toBe("mock-runtime-output");
  });
});
