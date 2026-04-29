import { describe, expect, it } from "vitest";

import { createMockRuntimeAdapter } from "../../src/harness/mock-runtime.js";

describe("createMockRuntimeAdapter", () => {
  it("runs without importing pi primitives", async () => {
    const adapter = createMockRuntimeAdapter();
    const result = await adapter.run(
      {
        instruction: "Run the mock harness",
        runId: "run-1",
        harness: { id: "harness.mock" },
        workspaceRoot: process.cwd(),
      },
      {
        events: { emit: async () => undefined },
        artifacts: {
          write: async () => ({
            id: "artifact",
            uri: "memory:///artifact",
            sha256: "hash",
            kind: "custom",
          }),
        },
        policy: {
          evaluate: async (input) => ({
            allowed: true,
            decision: {
              id: "policy-1",
              runId: input.runId,
              actorId: input.actorId,
              action: input.action,
              resource: input.resource,
              effect: "allow",
              decision: "allowed",
              reason: "ok",
              evidenceRefs: [],
            },
          }),
        },
      },
    );

    expect(result.harnessId).toBe("harness.mock");
    expect(result.adapter).toBe("external");
    expect(result.outputText).toBe("mock-runtime-output");
  });
});
