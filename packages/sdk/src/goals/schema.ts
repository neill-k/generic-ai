import type { JsonObject } from "../contracts/shared.js";
import { checkAgainstJsonSchema, type JsonSchemaIssue } from "./json-schema-check.js";
import {
  GOAL_NUMERIC_OPERATORS,
  GOAL_SPEC_SCHEMA_VERSION,
  GOAL_TRACE_ACTION_STATUSES,
  type GoalJudgment,
  type GoalSpec,
} from "./types.js";

/**
 * Machine-readable contracts for goals. They double as structured-output
 * schemas: hand `goalJudgmentJsonSchema` to a model judge, or
 * `goalSpecJsonSchema` to a planner that drafts goals for review.
 */

const nonEmptyString = { type: "string", minLength: 1 } as const;
const identifier = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  maxLength: 128,
} as const;
const targetRef = { type: "string", pattern: "^(output|artifact:.+)$" } as const;
const unitInterval = { type: "number", minimum: 0, maximum: 1 } as const;
const jsonObject = { type: "object" } as const;

const validatorBase = {
  id: identifier,
  description: { type: "string" },
  required: { type: "boolean" },
  fixHint: { type: "string" },
  metadata: jsonObject,
} as const;

export const goalSpecJsonSchema: JsonObject = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://generic-ai.dev/contracts/goals/goal-spec.schema.json",
  title: "GoalSpec",
  type: "object",
  additionalProperties: false,
  required: ["id", "objective", "definitionOfDone", "validators"],
  properties: {
    schemaVersion: { const: GOAL_SPEC_SCHEMA_VERSION },
    id: identifier,
    title: { type: "string" },
    objective: nonEmptyString,
    definitionOfDone: { type: "array", minItems: 1, items: nonEmptyString },
    validators: { type: "array", minItems: 1, items: { $ref: "#/$defs/validator" } },
    protectedPaths: { type: "array", items: nonEmptyString },
    maxAttempts: { type: "integer", minimum: 1 },
    metadata: jsonObject,
  },
  $defs: {
    validator: {
      anyOf: [
        { $ref: "#/$defs/numeric" },
        { $ref: "#/$defs/rubric" },
        { $ref: "#/$defs/trace" },
        { $ref: "#/$defs/output_schema" },
        { $ref: "#/$defs/check" },
      ],
    },
    numeric: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "source", "operator"],
      properties: {
        ...validatorBase,
        kind: { const: "numeric" },
        source: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["metric"],
              properties: { metric: nonEmptyString },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["outputPath"],
              properties: { outputPath: nonEmptyString, target: targetRef },
            },
          ],
        },
        operator: { enum: [...GOAL_NUMERIC_OPERATORS] },
        value: { type: "number" },
        min: { type: "number" },
        max: { type: "number" },
        tolerance: { type: "number", minimum: 0 },
        unit: { type: "string" },
      },
    },
    rubric: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "criteria"],
      properties: {
        ...validatorBase,
        kind: { const: "rubric" },
        target: targetRef,
        criteria: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description"],
            properties: {
              id: identifier,
              description: nonEmptyString,
              weight: { type: "number", exclusiveMinimum: 0 },
              required: { type: "boolean" },
              passScore: unitInterval,
            },
          },
        },
        passThreshold: unitInterval,
        judgeRef: nonEmptyString,
        judgeInstructions: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
      },
    },
    traceMatcher: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: identifier,
        description: { type: "string" },
        tool: nonEmptyString,
        event: nonEmptyString,
        role: nonEmptyString,
        status: { enum: [...GOAL_TRACE_ACTION_STATUSES] },
        argsInclude: jsonObject,
        minCount: { type: "integer", minimum: 0 },
        maxCount: { type: "integer", minimum: 0 },
      },
    },
    trace: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind"],
      properties: {
        ...validatorBase,
        kind: { const: "trace" },
        require: { type: "array", items: { $ref: "#/$defs/traceMatcher" } },
        forbid: { type: "array", items: { $ref: "#/$defs/traceMatcher" } },
        ordered: { type: "boolean" },
      },
    },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "schema"],
      properties: {
        ...validatorBase,
        kind: { const: "output_schema" },
        target: targetRef,
        schema: jsonObject,
      },
    },
    check: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "checkRef"],
      properties: {
        ...validatorBase,
        kind: { const: "check" },
        checkRef: nonEmptyString,
        config: jsonObject,
        timeoutMs: { type: "integer", minimum: 1 },
      },
    },
  },
}) as unknown as JsonObject;

/** Structured output a rubric judge (model or human) must return. */
export const goalJudgmentJsonSchema: JsonObject = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://generic-ai.dev/contracts/goals/goal-judgment.schema.json",
  title: "GoalJudgment",
  type: "object",
  additionalProperties: false,
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "score"],
        properties: {
          criterionId: nonEmptyString,
          score: unitInterval,
          rationale: { type: "string" },
          improvement: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
}) as unknown as JsonObject;

/** Shape of `GoalValidationReport`, for consumers that read it as JSON. */
export const goalValidationReportJsonSchema: JsonObject = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://generic-ai.dev/contracts/goals/goal-validation-report.schema.json",
  title: "GoalValidationReport",
  type: "object",
  required: [
    "kind",
    "goalId",
    "goalFingerprint",
    "status",
    "complete",
    "results",
    "summary",
    "feedback",
    "evaluatedAt",
  ],
  properties: {
    kind: { const: "goal-validation-report" },
    goalId: nonEmptyString,
    goalFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    status: { enum: ["COMPLETE", "INCOMPLETE"] },
    complete: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["validatorId", "kind", "required", "status", "message", "durationMs"],
        properties: {
          validatorId: nonEmptyString,
          kind: { enum: ["numeric", "rubric", "trace", "output_schema", "check"] },
          required: { type: "boolean" },
          status: { enum: ["passed", "failed", "error"] },
          message: { type: "string" },
          fix: { type: "string" },
          score: unitInterval,
          details: jsonObject,
          durationMs: { type: "number", minimum: 0 },
        },
      },
    },
    summary: {
      type: "object",
      required: ["required", "passed", "failed", "errored", "advisoryFailed"],
      properties: {
        required: { type: "integer", minimum: 0 },
        passed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        errored: { type: "integer", minimum: 0 },
        advisoryFailed: { type: "integer", minimum: 0 },
      },
    },
    feedback: { type: "string" },
    evaluatedAt: { type: "string" },
  },
}) as unknown as JsonObject;

export type GoalParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly JsonSchemaIssue[] };

export class GoalSpecError extends Error {
  readonly issues: readonly JsonSchemaIssue[];

  constructor(issues: readonly JsonSchemaIssue[]) {
    super(
      `Invalid goal spec: ${issues
        .slice(0, 10)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}${issues.length > 10 ? ` (and ${issues.length - 10} more)` : ""}`,
    );
    this.name = "GoalSpecError";
    this.issues = issues;
  }
}

/** Checks structure against `goalSpecJsonSchema`, then cross-field rules. */
export function parseGoalSpec(input: unknown): GoalParseResult<GoalSpec> {
  const structural = checkAgainstJsonSchema(goalSpecJsonSchema, input);
  if (!structural.valid) {
    return { ok: false, issues: structural.issues };
  }
  const spec = input as GoalSpec;
  const issues = semanticIssues(spec);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: spec };
}

function semanticIssues(spec: GoalSpec): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const seen = new Set<string>();

  spec.validators.forEach((validator, index) => {
    const path = `$.validators[${index}]`;
    if (seen.has(validator.id)) {
      add(
        `${path}.id`,
        `duplicates validator id ${JSON.stringify(validator.id)}; ids must be unique`,
      );
    }
    seen.add(validator.id);

    switch (validator.kind) {
      case "numeric": {
        if (validator.operator === "between") {
          if (validator.min === undefined || validator.max === undefined) {
            add(path, "operator between needs both min and max");
          } else if (validator.min > validator.max) {
            add(path, `min (${validator.min}) must not exceed max (${validator.max})`);
          }
        } else if (validator.value === undefined) {
          add(`${path}.value`, `operator ${validator.operator} needs a value`);
        }
        break;
      }
      case "rubric": {
        const criteria = new Set<string>();
        validator.criteria.forEach((criterion, criterionIndex) => {
          if (criteria.has(criterion.id)) {
            add(
              `${path}.criteria[${criterionIndex}].id`,
              `duplicates criterion id ${JSON.stringify(criterion.id)}`,
            );
          }
          criteria.add(criterion.id);
        });
        break;
      }
      case "trace": {
        const matchers = [
          ...(validator.require ?? []).map((matcher, i) => ({
            matcher,
            at: `${path}.require[${i}]`,
          })),
          ...(validator.forbid ?? []).map((matcher, i) => ({
            matcher,
            at: `${path}.forbid[${i}]`,
          })),
        ];
        if (matchers.length === 0) {
          add(path, "a trace validator needs at least one require or forbid matcher");
        }
        for (const { matcher, at } of matchers) {
          if (
            matcher.tool === undefined &&
            matcher.event === undefined &&
            matcher.role === undefined
          ) {
            add(at, "a matcher needs at least one of tool, event, or role");
          }
          if (
            matcher.minCount !== undefined &&
            matcher.maxCount !== undefined &&
            matcher.minCount > matcher.maxCount
          ) {
            add(
              at,
              `minCount (${matcher.minCount}) must not exceed maxCount (${matcher.maxCount})`,
            );
          }
        }
        break;
      }
      case "output_schema":
      case "check":
        break;
    }
  });

  return issues;
}

/** Parses and checks structured judge output, accepting a JSON string or object. */
export function parseGoalJudgment(input: unknown): GoalParseResult<GoalJudgment> {
  let value = input;
  if (typeof input === "string") {
    const parsed = parseJsonLoosely(input);
    if (parsed === undefined) {
      return { ok: false, issues: [{ path: "$", message: "judge output is not valid JSON" }] };
    }
    value = parsed;
  }
  const result = checkAgainstJsonSchema(goalJudgmentJsonSchema, value);
  return result.valid
    ? { ok: true, value: value as GoalJudgment }
    : { ok: false, issues: result.issues };
}

/**
 * Parses JSON, also accepting the common model habit of wrapping it in a
 * fenced code block. Returns `undefined` when nothing parses.
 */
export function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    candidates.push(fenced[1].trim());
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
