import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/contracts/shared.js";
import { checkAgainstJsonSchema, jsonDeepEqual } from "../../src/goals/index.js";

const reportSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["title", "score", "tags"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: 20 },
    score: { type: "number", minimum: 0, maximum: 1 },
    count: { type: "integer", exclusiveMinimum: 0, multipleOf: 2 },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { enum: ["a", "b", "c"] },
    },
    slug: { type: "string", pattern: "^[a-z-]+$" },
    nested: { type: "object", properties: { ok: { const: true } } },
    extra: { type: ["string", "null"] },
  },
};

describe("checkAgainstJsonSchema", () => {
  it("accepts a conforming value", () => {
    const result = checkAgainstJsonSchema(reportSchema, {
      title: "Quarterly",
      score: 0.5,
      count: 4,
      tags: ["a", "b"],
      slug: "q-report",
      nested: { ok: true },
      extra: null,
    });
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("reports every problem with a path an agent can act on", () => {
    const result = checkAgainstJsonSchema(reportSchema, {
      title: "Q",
      score: 2,
      count: 3,
      tags: ["a", "a", "z"],
      slug: "Bad Slug",
      nested: { ok: false },
      extra: 5,
      surprise: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "$.title", message: "must be at least 3 characters, got 1" },
        { path: "$.score", message: "must be <= 1, got 2" },
        { path: "$.count", message: "must be a multiple of 2, got 3" },
        { path: "$.tags[1]", message: "duplicates an earlier item; items must be unique" },
        { path: "$.tags[2]", message: 'must be one of "a", "b", "c", got string "z"' },
        { path: "$.slug", message: 'must match pattern "^[a-z-]+$"' },
        { path: "$.nested.ok", message: "must equal true, got boolean false" },
        { path: "$.extra", message: "expected string or null, got integer 5" },
        expect.objectContaining({ path: "$.surprise" }),
      ]),
    );
  });

  it("reports missing required properties and wrong root types", () => {
    expect(checkAgainstJsonSchema(reportSchema, {}).issues.map((issue) => issue.path)).toEqual([
      "$.title",
      "$.score",
      "$.tags",
    ]);
    expect(checkAgainstJsonSchema(reportSchema, "nope").issues).toEqual([
      { path: "$", message: 'expected object, got string "nope"' },
    ]);
  });

  it("resolves local refs and picks the discriminated branch for anyOf errors", () => {
    const schema: JsonObject = {
      type: "array",
      items: { $ref: "#/$defs/shape" },
      $defs: {
        shape: { anyOf: [{ $ref: "#/$defs/circle" }, { $ref: "#/$defs/square" }] },
        circle: {
          type: "object",
          required: ["kind", "radius"],
          properties: { kind: { const: "circle" }, radius: { type: "number" } },
        },
        square: {
          type: "object",
          required: ["kind", "side"],
          properties: { kind: { const: "square" }, side: { type: "number" } },
        },
      },
    };
    expect(checkAgainstJsonSchema(schema, [{ kind: "circle", radius: 1 }]).valid).toBe(true);
    expect(checkAgainstJsonSchema(schema, [{ kind: "square", side: "big" }]).issues).toEqual([
      { path: "$[0].side", message: 'expected number, got string "big"' },
    ]);
    expect(checkAgainstJsonSchema(schema, [{ kind: "triangle" }]).issues).toEqual([
      { path: "$[0].kind", message: 'must be one of "circle", "square", got string "triangle"' },
    ]);
  });

  it("handles oneOf, allOf, not, and boolean schemas", () => {
    const oneOf: JsonObject = { oneOf: [{ type: "number" }, { type: "integer" }] };
    expect(checkAgainstJsonSchema(oneOf, 1.5).valid).toBe(true);
    expect(checkAgainstJsonSchema(oneOf, 2).issues[0]?.message).toContain("exactly one");
    expect(checkAgainstJsonSchema({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 5).valid).toBe(
      false,
    );
    expect(checkAgainstJsonSchema({ not: { type: "string" } }, "x").valid).toBe(false);
    expect(checkAgainstJsonSchema(false, 1).valid).toBe(false);
    expect(checkAgainstJsonSchema(true, 1).valid).toBe(true);
  });

  it("reports unresolvable refs instead of passing silently", () => {
    expect(checkAgainstJsonSchema({ $ref: "#/$defs/missing" }, 1).issues[0]?.message).toContain(
      "could not be resolved",
    );
  });

  it("compares JSON values structurally", () => {
    expect(jsonDeepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
  });
});
