import type { JsonSchemaIssue } from "../goals/json-schema-check.js";
import { type GoalParseResult, GoalSpecError, parseGoalSpec } from "../goals/schema.js";
import { sealGoal } from "../goals/seal.js";
import type { GoalSpec, SealedGoal } from "../goals/types.js";
import {
  GOAL_EVAL_SCHEMA_VERSION,
  type GoalEvalCaseSpec,
  type GoalEvalGateSpec,
  type GoalEvalSuiteSpec,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isFraction(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function prefixIssues(prefix: string, issues: readonly JsonSchemaIssue[]): JsonSchemaIssue[] {
  return issues.map((issue) => ({
    path: issue.path.startsWith("$")
      ? `${prefix}${issue.path.slice(1)}`
      : `${prefix}.${issue.path}`,
    message: issue.message,
  }));
}

/** The goal that holds a case's held-out validators. */
export function holdoutGoalSpec(caseSpec: GoalEvalCaseSpec): GoalSpec | undefined {
  const validators = caseSpec.holdoutValidators ?? [];
  if (validators.length === 0) {
    return undefined;
  }
  return {
    id: `${caseSpec.goal.id}:holdout`,
    objective: caseSpec.goal.objective,
    definitionOfDone: caseSpec.goal.definitionOfDone,
    validators,
  };
}

function gateIssues(gate: unknown): JsonSchemaIssue[] {
  if (gate === undefined) {
    return [];
  }
  if (!isPlainObject(gate)) {
    return [{ path: "$.gate", message: "gate must be an object." }];
  }
  const issues: JsonSchemaIssue[] = [];
  const check = (key: keyof GoalEvalGateSpec, ok: (value: unknown) => boolean, rule: string) => {
    const value = gate[key];
    if (value !== undefined && !ok(value)) {
      issues.push({ path: `$.gate.${key}`, message: `${key} must be ${rule}.` });
    }
  };
  check("minPassRate", isFraction, "a number between 0 and 1");
  check("minPassK", isFraction, "a number between 0 and 1");
  check("maxTokensPerCompletedGoal", isNonNegative, "a non-negative number");
  check("maxCostPerCompletedGoalUsd", isNonNegative, "a non-negative number");
  check(
    "maxIntegrityViolations",
    (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
    "a non-negative integer",
  );
  check("minTrialsPerCase", isPositiveInteger, "a positive integer");
  return issues;
}

function caseIssues(value: unknown, index: number, seen: Set<string>): JsonSchemaIssue[] {
  const path = `$.cases[${index}]`;
  if (!isPlainObject(value)) {
    return [{ path, message: "Each case must be an object." }];
  }
  const issues: JsonSchemaIssue[] = [];
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    issues.push({ path: `${path}.id`, message: "Case id must be a non-empty string." });
  } else if (seen.has(id)) {
    issues.push({ path: `${path}.id`, message: `Duplicate case id "${id}".` });
  } else {
    seen.add(id);
  }
  const goal = parseGoalSpec(value["goal"]);
  if (!goal.ok) {
    issues.push(...prefixIssues(`${path}.goal`, goal.issues));
    return issues;
  }
  const holdout = value["holdoutValidators"];
  if (holdout !== undefined) {
    if (!Array.isArray(holdout) || holdout.length === 0) {
      issues.push({
        path: `${path}.holdoutValidators`,
        message: "holdoutValidators must be a non-empty array when present.",
      });
    } else {
      const parsed = parseGoalSpec({
        id: goal.value.id,
        objective: goal.value.objective,
        definitionOfDone: goal.value.definitionOfDone,
        validators: holdout,
      });
      if (!parsed.ok) {
        issues.push(
          ...prefixIssues(path, parsed.issues).map((issue) => ({
            ...issue,
            path: issue.path.replace(`${path}.validators`, `${path}.holdoutValidators`),
          })),
        );
      }
    }
  }
  for (const key of ["hiddenPaths", "tags"] as const) {
    const list = value[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))
    ) {
      issues.push({ path: `${path}.${key}`, message: `${key} must be an array of strings.` });
    }
  }
  const metrics = value["metrics"];
  if (
    metrics !== undefined &&
    (!isPlainObject(metrics) ||
      Object.values(metrics).some(
        (metric) => typeof metric !== "number" || !Number.isFinite(metric),
      ))
  ) {
    issues.push({ path: `${path}.metrics`, message: "metrics must map names to finite numbers." });
  }
  if (value["trials"] !== undefined && !isPositiveInteger(value["trials"])) {
    issues.push({ path: `${path}.trials`, message: "trials must be a positive integer." });
  }
  if (value["instruction"] !== undefined && typeof value["instruction"] !== "string") {
    issues.push({ path: `${path}.instruction`, message: "instruction must be a string." });
  }
  return issues;
}

/** Checks an eval suite, including every case's goal and held-out validators. */
export function parseGoalEvalSuite(input: unknown): GoalParseResult<GoalEvalSuiteSpec> {
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: "$", message: "Suite must be an object." }] };
  }
  const issues: JsonSchemaIssue[] = [];
  if (input["kind"] !== "generic-ai.goal-eval-suite") {
    issues.push({ path: "$.kind", message: 'kind must be "generic-ai.goal-eval-suite".' });
  }
  if (input["schemaVersion"] !== undefined && input["schemaVersion"] !== GOAL_EVAL_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `schemaVersion must be "${GOAL_EVAL_SCHEMA_VERSION}".`,
    });
  }
  if (typeof input["id"] !== "string" || input["id"].length === 0) {
    issues.push({ path: "$.id", message: "Suite id must be a non-empty string." });
  }
  const cases = input["cases"];
  if (!Array.isArray(cases) || cases.length === 0) {
    issues.push({ path: "$.cases", message: "A suite needs at least one case." });
  } else {
    const seen = new Set<string>();
    cases.forEach((caseSpec, index) => {
      issues.push(...caseIssues(caseSpec, index, seen));
    });
  }
  const trials = input["trials"];
  if (trials !== undefined) {
    if (!isPlainObject(trials)) {
      issues.push({ path: "$.trials", message: "trials must be an object." });
    } else {
      for (const key of ["count", "passK"] as const) {
        if (trials[key] !== undefined && !isPositiveInteger(trials[key])) {
          issues.push({ path: `$.trials.${key}`, message: `${key} must be a positive integer.` });
        }
      }
    }
  }
  issues.push(...gateIssues(input["gate"]));
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as GoalEvalSuiteSpec };
}

/** Like `parseGoalEvalSuite`, but throws `GoalSpecError` on invalid input. */
export function assertGoalEvalSuite(input: unknown): GoalEvalSuiteSpec {
  const parsed = parseGoalEvalSuite(input);
  if (!parsed.ok) {
    throw new GoalSpecError(parsed.issues);
  }
  return parsed.value;
}

/** A case's goals, sealed so neither the agent nor a check can change them mid-eval. */
export interface SealedGoalEvalCase {
  readonly caseSpec: GoalEvalCaseSpec;
  readonly goal: SealedGoal;
  readonly holdout?: SealedGoal;
}

export function sealGoalEvalCase(caseSpec: GoalEvalCaseSpec): SealedGoalEvalCase {
  const holdoutSpec = holdoutGoalSpec(caseSpec);
  return Object.freeze({
    caseSpec,
    goal: sealGoal(caseSpec.goal),
    ...(holdoutSpec === undefined ? {} : { holdout: sealGoal(holdoutSpec) }),
  });
}

/** Attempts to run for a case. */
export function goalEvalTrialCount(suite: GoalEvalSuiteSpec, caseSpec: GoalEvalCaseSpec): number {
  return caseSpec.trials ?? suite.trials?.count ?? 1;
}
