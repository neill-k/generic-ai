import { describe, expect, it } from "vitest";
import {
  type GoalSpec,
  GoalSpecError,
  GoalTamperError,
  assertGoalIntact,
  checkAgainstJsonSchema,
  fingerprintGoalSpec,
  goalSpecJsonSchema,
  isSealedGoal,
  parseGoalJudgment,
  parseGoalSpec,
  parseJsonLoosely,
  sealGoal,
} from "../../src/goals/index.js";
import * as sdk from "../../src/index.js";

function sampleGoal(): GoalSpec {
  return {
    schemaVersion: "generic-ai.goal/v1",
    id: "quarterly-report",
    title: "Quarterly report",
    objective: "Write the Q3 revenue report.",
    definitionOfDone: ["Report covers every region", "Totals reconcile with the ledger"],
    validators: [
      {
        id: "coverage",
        kind: "numeric",
        source: { metric: "regionCoverage" },
        operator: "gte",
        value: 1,
      },
      {
        id: "quality",
        kind: "rubric",
        criteria: [
          { id: "clarity", description: "Plain, skimmable prose" },
          { id: "accuracy", description: "Numbers match the ledger", required: true, weight: 2 },
        ],
        passThreshold: 0.8,
      },
      {
        id: "read-ledger",
        kind: "trace",
        require: [{ tool: "read_file", argsInclude: { path: "ledger.csv" } }],
      },
      {
        id: "shape",
        kind: "output_schema",
        schema: { type: "object", required: ["total"], properties: { total: { type: "number" } } },
      },
      { id: "tests", kind: "check", checkRef: "npm-test", config: { script: "test" } },
    ],
    protectedPaths: ["validators/"],
    maxAttempts: 5,
  };
}

describe("goal spec contract", () => {
  it("accepts a complete spec and exports it from the package root", () => {
    expect(parseGoalSpec(sampleGoal())).toEqual({ ok: true, value: sampleGoal() });
    expect(sdk.sealGoal).toBe(sealGoal);
    expect(sdk.goals.runGoalValidators).toBeTypeOf("function");
  });

  it("requires at least one validator, because an unverifiable goal is not a goal", () => {
    const result = parseGoalSpec({ ...sampleGoal(), validators: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toEqual([
      { path: "$.validators", message: "must have at least 1 item(s), got 0" },
    ]);
  });

  it("names the failing field for an unknown or malformed validator", () => {
    const unknownKind = parseGoalSpec({
      ...sampleGoal(),
      validators: [{ id: "x", kind: "vibes" }],
    });
    expect(!unknownKind.ok && unknownKind.issues[0]).toEqual({
      path: "$.validators[0].kind",
      message:
        'must be one of "numeric", "rubric", "trace", "output_schema", "check", got string "vibes"',
    });

    const badRubric = parseGoalSpec({
      ...sampleGoal(),
      validators: [{ id: "q", kind: "rubric", criteria: [], passThreshold: 3 }],
    });
    expect(!badRubric.ok && badRubric.issues).toEqual([
      { path: "$.validators[0].criteria", message: "must have at least 1 item(s), got 0" },
      { path: "$.validators[0].passThreshold", message: "must be <= 1, got 3" },
    ]);
  });

  it("applies cross-field rules", () => {
    const result = parseGoalSpec({
      ...sampleGoal(),
      validators: [
        { id: "a", kind: "numeric", source: { metric: "m" }, operator: "between", min: 5, max: 1 },
        { id: "a", kind: "numeric", source: { metric: "m" }, operator: "gt" },
        { id: "t", kind: "trace", require: [{ minCount: 3, maxCount: 1 }] },
        { id: "empty", kind: "trace" },
        {
          id: "r",
          kind: "rubric",
          criteria: [
            { id: "c", description: "one" },
            { id: "c", description: "two" },
          ],
        },
      ],
    });
    expect(!result.ok && result.issues.map((issue) => issue.message)).toEqual([
      "min (5) must not exceed max (1)",
      'duplicates validator id "a"; ids must be unique',
      "operator gt needs a value",
      "a matcher needs at least one of tool, event, or role",
      "minCount (3) must not exceed maxCount (1)",
      "a trace validator needs at least one require or forbid matcher",
      'duplicates criterion id "c"',
    ]);
  });

  it("keeps the published JSON Schema self-consistent", () => {
    expect(goalSpecJsonSchema["$id"]).toBe(
      "https://generic-ai.dev/contracts/goals/goal-spec.schema.json",
    );
    expect(checkAgainstJsonSchema(goalSpecJsonSchema, sampleGoal()).valid).toBe(true);
  });
});

describe("sealing", () => {
  it("copies, freezes, and fingerprints the spec", () => {
    const source = sampleGoal();
    const sealed = sealGoal(source);

    expect(isSealedGoal(sealed)).toBe(true);
    expect(sealed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(sealed.spec)).toBe(true);
    expect(Object.isFrozen(sealed.spec.validators[0])).toBe(true);

    // The caller's object is not the sealed one, so editing it later changes nothing.
    (source.validators as unknown[]).length = 0;
    expect(sealed.spec.validators).toHaveLength(5);

    expect(() => {
      (sealed.spec.validators as unknown[]).push({ id: "cheat" });
    }).toThrow(TypeError);
    expect(() => {
      (sealed.spec.validators[0] as { value: number }).value = 0;
    }).toThrow(TypeError);
  });

  it("produces the same fingerprint regardless of key order", () => {
    const reversed = Object.fromEntries(
      Object.entries(sampleGoal()).reverse(),
    ) as unknown as GoalSpec;
    expect(fingerprintGoalSpec(reversed)).toBe(fingerprintGoalSpec(sampleGoal()));
    expect(sealGoal(sampleGoal()).fingerprint).not.toBe(
      sealGoal({ ...sampleGoal(), objective: "Something else." }).fingerprint,
    );
  });

  it("refuses look-alike goals and fingerprint mismatches", () => {
    const sealed = sealGoal(sampleGoal());
    const forged = {
      kind: "sealed-goal" as const,
      spec: sealed.spec,
      fingerprint: sealed.fingerprint,
    };

    expect(() => assertGoalIntact(forged)).toThrow(GoalTamperError);
    expect(() => assertGoalIntact(sealed)).not.toThrow();
    expect(() => assertGoalIntact(sealed, "0".repeat(64))).toThrow(/expected fingerprint/);
  });

  it("throws GoalSpecError with the issues for an invalid spec", () => {
    expect(() => sealGoal({ id: "x" })).toThrow(GoalSpecError);
    try {
      sealGoal({ id: "x" });
    } catch (error) {
      expect((error as GoalSpecError).issues.map((issue) => issue.path)).toEqual([
        "$.objective",
        "$.definitionOfDone",
        "$.validators",
      ]);
    }
  });
});

describe("structured judge output", () => {
  it("parses JSON, fenced JSON, and objects", () => {
    expect(parseGoalJudgment('{"criteria":[{"criterionId":"a","score":1}]}').ok).toBe(true);
    expect(
      parseGoalJudgment(
        'Here you go:\n```json\n{"criteria":[{"criterionId":"a","score":0.5}]}\n```',
      ).ok,
    ).toBe(true);
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(
      parseGoalJudgment({ criteria: [{ criterionId: "a", score: 0.2, improvement: "add data" }] })
        .ok,
    ).toBe(true);
  });

  it("rejects out-of-range scores and prose", () => {
    const outOfRange = parseGoalJudgment({ criteria: [{ criterionId: "a", score: 7 }] });
    expect(!outOfRange.ok && outOfRange.issues[0]?.path).toBe("$.criteria[0].score");
    expect(parseGoalJudgment("looks great").ok).toBe(false);
  });
});
