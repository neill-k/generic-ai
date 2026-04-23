import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  DelegationExecutorContext,
  DelegationRequest,
  DelegationResult,
} from "../src/index.js";
import { kind, name } from "../src/index.js";

describe("@generic-ai/plugin-delegation", () => {
  it("exports the delegation capability markers", () => {
    expect(name).toBe("@generic-ai/plugin-delegation");
    expect(kind).toBe("delegation");
  });

  it("re-exports the shared delegation contract types", () => {
    expectTypeOf<DelegationRequest<{ prompt: string }>["agentId"]>().toEqualTypeOf<string>();
    expectTypeOf<DelegationRequest<{ prompt: string }>["task"]>().toEqualTypeOf<{
      prompt: string;
    }>();
    expectTypeOf<DelegationExecutorContext["childSessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<DelegationResult<{ summary: string }>["status"]>().toEqualTypeOf<
      "succeeded" | "failed" | "cancelled"
    >();
  });
});
