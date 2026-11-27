import { describe, expect, it } from "vitest";

import { parseActorDirectives } from "./directives.js";

describe("parseActorDirectives", () => {
  it("reads the last verdict line and the last JSON block", () => {
    expect(parseActorDirectives("Looks off.\nVERDICT: FAIL\nfixed\n**Verdict:** pass")).toEqual({
      verdict: "pass",
    });
    const parsed = parseActorDirectives(
      'Plan:\n```json\n{"assignments":[{"actorRef":"a","task":"x"}]}\n```\n```json\nnot json\n```',
    );
    expect(parsed.data).toEqual({ assignments: [{ actorRef: "a", task: "x" }] });
    expect(parseActorDirectives('```json\n{"verdict":"FAIL"}\n```\nVERDICT: PASS').verdict).toBe(
      "fail",
    );
    expect(parseActorDirectives(undefined)).toEqual({});
  });
});
