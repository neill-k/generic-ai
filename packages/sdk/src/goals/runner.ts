import type { JsonObject, JsonValue } from "../contracts/shared.js";
import { checkAgainstJsonSchema, formatJsonSchemaIssues } from "./json-schema-check.js";
import { goalJudgmentJsonSchema, parseGoalJudgment, parseJsonLoosely } from "./schema.js";
import { assertGoalIntact } from "./seal.js";
import { describeTraceMatcher, findProtectedPathViolations, matchesTraceEntry } from "./trace.js";
import type {
  GoalCheck,
  GoalCheckValidatorSpec,
  GoalEvidence,
  GoalJudge,
  GoalNumericValidatorSpec,
  GoalOutputSchemaValidatorSpec,
  GoalRubricJudgeRequest,
  GoalRubricValidatorSpec,
  GoalSpec,
  GoalTargetRef,
  GoalTraceActionMatcher,
  GoalTraceEntry,
  GoalTraceValidatorSpec,
  GoalValidationReport,
  GoalValidatorResult,
  GoalValidatorSpec,
  RunGoalValidatorsOptions,
  SealedGoal,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RUBRIC_THRESHOLD = 0.7;
export const PROTECTED_PATHS_VALIDATOR_ID = "integrity.protected-paths";

type ResultBody = Omit<GoalValidatorResult, "validatorId" | "kind" | "required" | "durationMs">;

interface RunContext {
  readonly spec: GoalSpec;
  readonly evidence: GoalEvidence;
  readonly options: RunGoalValidatorsOptions;
  readonly signal: AbortSignal;
}

/**
 * Runs every validator of a sealed goal against the evidence of one attempt.
 *
 * The goal must come from `sealGoal` and be unchanged since; otherwise this
 * throws `GoalTamperError` before running anything. Validators never throw:
 * a validator that cannot run reports `error`, which blocks completion when
 * the validator is required.
 */
export async function runGoalValidators(
  goal: SealedGoal,
  evidence: GoalEvidence,
  options: RunGoalValidatorsOptions & { readonly expectedFingerprint?: string } = {},
): Promise<GoalValidationReport> {
  assertGoalIntact(goal, options.expectedFingerprint);
  const { spec } = goal;
  const signal = options.signal ?? new AbortController().signal;
  const context: RunContext = { spec, evidence, options, signal };

  const results = await Promise.all(spec.validators.map((validator) => runOne(validator, context)));

  if (spec.protectedPaths !== undefined && spec.protectedPaths.length > 0) {
    results.push(checkProtectedPaths(spec.protectedPaths, evidence.trace ?? []));
  }

  // Re-check after the validators ran, so a validator implementation (or an
  // agent racing it) cannot mutate the goal mid-run without being caught.
  assertGoalIntact(goal, options.expectedFingerprint);

  const required = results.filter((result) => result.required);
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = required.filter((result) => result.status === "failed").length;
  const errored = required.filter((result) => result.status === "error").length;
  const advisoryFailed = results.filter(
    (result) => !result.required && result.status !== "passed",
  ).length;
  const complete = failed === 0 && errored === 0;

  return Object.freeze({
    kind: "goal-validation-report",
    goalId: spec.id,
    goalFingerprint: goal.fingerprint,
    status: complete ? "COMPLETE" : "INCOMPLETE",
    complete,
    results: Object.freeze(results),
    summary: Object.freeze({ required: required.length, passed, failed, errored, advisoryFailed }),
    feedback: formatGoalFeedback(spec, results),
    evaluatedAt: (options.now?.() ?? new Date()).toISOString(),
  });
}

async function runOne(
  validator: GoalValidatorSpec,
  context: RunContext,
): Promise<GoalValidatorResult> {
  const started = performance.now();
  let body: ResultBody;
  try {
    body = await dispatch(validator, context);
  } catch (error) {
    body = {
      status: "error",
      message: `Validator could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const fix = body.status === "passed" ? undefined : joinSentences(body.fix, validator.fixHint);
  return Object.freeze({
    validatorId: validator.id,
    kind: validator.kind,
    required: validator.required !== false,
    ...body,
    ...(fix === undefined ? {} : { fix }),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  });
}

function dispatch(
  validator: GoalValidatorSpec,
  context: RunContext,
): Promise<ResultBody> | ResultBody {
  switch (validator.kind) {
    case "numeric":
      return runNumeric(validator, context.evidence);
    case "rubric":
      return runRubric(validator, context);
    case "trace":
      return runTrace(validator, context.evidence.trace ?? []);
    case "output_schema":
      return runOutputSchema(validator, context.evidence);
    case "check":
      return runCheck(validator, context);
  }
}

function joinSentences(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter(
    (part): part is string => part !== undefined && part.trim().length > 0,
  );
  return present.length === 0 ? undefined : present.join(" ");
}

// ---------------------------------------------------------------- subjects

function targetLabel(target: GoalTargetRef | undefined): string {
  return target === undefined || target === "output"
    ? "the final output"
    : `artifact ${target.slice(9)}`;
}

function textSubject(
  evidence: GoalEvidence,
  target: GoalTargetRef | undefined,
): string | undefined {
  if (target === undefined || target === "output") {
    if (evidence.outputText !== undefined) {
      return evidence.outputText;
    }
    return evidence.output === undefined ? undefined : JSON.stringify(evidence.output, null, 2);
  }
  return evidence.artifacts?.[target.slice("artifact:".length)];
}

type StructuredSubject =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly reason: "missing" | "not_json" };

function structuredSubject(
  evidence: GoalEvidence,
  target: GoalTargetRef | undefined,
): StructuredSubject {
  if ((target === undefined || target === "output") && evidence.output !== undefined) {
    return { found: true, value: evidence.output };
  }
  const text = textSubject(evidence, target);
  if (text === undefined) {
    return { found: false, reason: "missing" };
  }
  const parsed = parseJsonLoosely(text);
  return parsed === undefined
    ? { found: false, reason: "not_json" }
    : { found: true, value: parsed };
}

function missingSubject(
  subject: Extract<StructuredSubject, { found: false }>,
  target: GoalTargetRef | undefined,
): ResultBody {
  const label = targetLabel(target);
  return subject.reason === "missing"
    ? {
        status: "failed",
        message: `No ${label} was produced, so this check had nothing to inspect.`,
        fix: `Produce ${label}.`,
      }
    : {
        status: "failed",
        message: `${capitalize(label)} is not valid JSON.`,
        fix: `Return ${label} as a single valid JSON value with no surrounding prose.`,
      };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/** Reads `a.b[0].c` (or `a.b.0.c`) from a JSON value. */
export function readJsonPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// ---------------------------------------------------------------- numeric

function expectation(validator: GoalNumericValidatorSpec): string {
  const unit = validator.unit === undefined ? "" : ` ${validator.unit}`;
  const tolerance =
    validator.tolerance !== undefined && validator.tolerance > 0
      ? ` (±${validator.tolerance})`
      : "";
  switch (validator.operator) {
    case "between":
      return `between ${validator.min} and ${validator.max}${unit}`;
    case "eq":
      return `= ${validator.value}${unit}${tolerance}`;
    case "neq":
      return `≠ ${validator.value}${unit}${tolerance}`;
    case "gt":
      return `> ${validator.value}${unit}`;
    case "gte":
      return `>= ${validator.value}${unit}`;
    case "lt":
      return `< ${validator.value}${unit}`;
    case "lte":
      return `<= ${validator.value}${unit}`;
  }
}

function compare(validator: GoalNumericValidatorSpec, observed: number): boolean {
  const value = validator.value ?? Number.NaN;
  const tolerance = validator.tolerance ?? 0;
  switch (validator.operator) {
    case "between":
      return observed >= (validator.min ?? Number.NaN) && observed <= (validator.max ?? Number.NaN);
    case "eq":
      return Math.abs(observed - value) <= tolerance;
    case "neq":
      return Math.abs(observed - value) > tolerance;
    case "gt":
      return observed > value;
    case "gte":
      return observed >= value;
    case "lt":
      return observed < value;
    case "lte":
      return observed <= value;
  }
}

function runNumeric(validator: GoalNumericValidatorSpec, evidence: GoalEvidence): ResultBody {
  const source = validator.source;
  const label =
    "metric" in source
      ? `metric ${source.metric}`
      : `${source.outputPath} in ${targetLabel(source.target)}`;
  const expected = expectation(validator);
  let observed: unknown;

  if ("metric" in source) {
    observed = evidence.metrics?.[source.metric];
    if (observed === undefined) {
      return {
        status: "failed",
        message: `${capitalize(label)} was not reported; it must be ${expected}.`,
        fix: `Measure and report ${source.metric}.`,
        expected,
      };
    }
  } else {
    const subject = structuredSubject(evidence, source.target);
    if (!subject.found) {
      return missingSubject(subject, source.target);
    }
    observed = readJsonPath(subject.value, source.outputPath);
    if (observed === undefined) {
      return {
        status: "failed",
        message: `${capitalize(targetLabel(source.target))} has no value at ${source.outputPath}; it must be a number ${expected}.`,
        fix: `Include ${source.outputPath} as a number in ${targetLabel(source.target)}.`,
        expected,
      };
    }
  }

  if (typeof observed !== "number" || !Number.isFinite(observed)) {
    return {
      status: "failed",
      message: `${capitalize(label)} is ${JSON.stringify(observed)}, not a finite number.`,
      fix: `Report ${label} as a number.`,
      expected,
      ...(isJsonValue(observed) ? { observed } : {}),
    };
  }

  if (compare(validator, observed)) {
    return {
      status: "passed",
      message: `${capitalize(label)} is ${observed}; needs ${expected}.`,
      observed,
      expected,
    };
  }
  return {
    status: "failed",
    message: `${capitalize(label)} is ${observed}; needs ${expected}.`,
    fix: `Change the work so ${label} becomes ${expected} (currently ${observed}).`,
    observed,
    expected,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    Array.isArray(value) ||
    typeof value === "object"
  );
}

// ---------------------------------------------------------------- rubric

function resolveJudge(options: RunGoalValidatorsOptions, ref: string): GoalJudge | undefined {
  const judges = options.judges;
  if (judges === undefined) {
    return undefined;
  }
  if (typeof judges === "function") {
    return ref === "default" ? judges : undefined;
  }
  return Object.hasOwn(judges, ref) ? judges[ref] : undefined;
}

async function runRubric(
  validator: GoalRubricValidatorSpec,
  context: RunContext,
): Promise<ResultBody> {
  const judgeRef = validator.judgeRef ?? "default";
  const judge = resolveJudge(context.options, judgeRef);
  if (judge === undefined) {
    return {
      status: "error",
      message: `No rubric judge is registered as ${JSON.stringify(judgeRef)}; the host must supply one.`,
    };
  }

  const subject = textSubject(context.evidence, validator.target);
  if (subject === undefined || subject.trim().length === 0) {
    return missingSubject({ found: false, reason: "missing" }, validator.target);
  }

  const raw = await withTimeout(
    (signal) => {
      const request: GoalRubricJudgeRequest = {
        goalId: context.spec.id,
        validatorId: validator.id,
        objective: context.spec.objective,
        definitionOfDone: context.spec.definitionOfDone,
        criteria: validator.criteria,
        subject,
        ...(validator.judgeInstructions === undefined
          ? {}
          : { instructions: validator.judgeInstructions }),
        signal,
      };
      return judge(request);
    },
    validator.timeoutMs ?? context.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    context.signal,
    `rubric judge ${judgeRef}`,
  );

  const parsed = parseGoalJudgment(raw);
  if (!parsed.ok) {
    return {
      status: "error",
      message: `Judge ${judgeRef} returned output that does not match the judgment schema: ${formatJsonSchemaIssues(parsed.issues)}`,
    };
  }

  const scores = new Map(parsed.value.criteria.map((entry) => [entry.criterionId, entry]));
  const missing = validator.criteria.filter((criterion) => !scores.has(criterion.id));
  if (missing.length > 0) {
    return {
      status: "error",
      message: `Judge ${judgeRef} did not score criteria: ${missing.map((criterion) => criterion.id).join(", ")}.`,
    };
  }

  const threshold = validator.passThreshold ?? DEFAULT_RUBRIC_THRESHOLD;
  let weighted = 0;
  let totalWeight = 0;
  const shortfalls: string[] = [];
  const improvements: string[] = [];
  const perCriterion: JsonObject[] = [];
  let requiredCriterionFailed = false;

  for (const criterion of validator.criteria) {
    const judgment = scores.get(criterion.id);
    const score = judgment?.score ?? 0;
    const weight = criterion.weight ?? 1;
    weighted += score * weight;
    totalWeight += weight;
    const passScore = criterion.passScore ?? threshold;
    const criterionPassed = score >= passScore;
    if (!criterionPassed) {
      if (criterion.required === true) {
        requiredCriterionFailed = true;
      }
      shortfalls.push(
        `${criterion.id} scored ${formatScore(score)} (needs ${formatScore(passScore)}${criterion.required === true ? ", required" : ""})${
          judgment?.rationale === undefined ? "" : `: ${judgment.rationale}`
        }`,
      );
      if (judgment?.improvement !== undefined && judgment.improvement.trim().length > 0) {
        improvements.push(`${criterion.id}: ${judgment.improvement}`);
      } else {
        improvements.push(`${criterion.id}: ${criterion.description}`);
      }
    }
    perCriterion.push({
      criterionId: criterion.id,
      score,
      passScore,
      passed: criterionPassed,
      ...(judgment?.rationale === undefined ? {} : { rationale: judgment.rationale }),
    });
  }

  const score = totalWeight === 0 ? 0 : weighted / totalWeight;
  const passed = score >= threshold && !requiredCriterionFailed;
  const details: JsonObject = {
    judgeRef,
    threshold,
    criteria: perCriterion,
    ...(parsed.value.summary === undefined ? {} : { summary: parsed.value.summary }),
  };

  if (passed) {
    return {
      status: "passed",
      message: `Rubric score ${formatScore(score)} meets ${formatScore(threshold)}.`,
      score,
      details,
    };
  }
  return {
    status: "failed",
    message: `Rubric score ${formatScore(score)} (needs ${formatScore(threshold)}${
      requiredCriterionFailed ? " and every required criterion" : ""
    }). Weak criteria: ${shortfalls.join("; ")}.`,
    fix: `Improve ${targetLabel(validator.target)}: ${improvements.join("; ")}.`,
    score,
    details,
  };
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

/**
 * Builds a prompt for a model judge. Pair it with `goalJudgmentJsonSchema` as
 * the structured-output schema, and feed the reply to `parseGoalJudgment`.
 */
export function buildRubricJudgePrompt(request: Omit<GoalRubricJudgeRequest, "signal">): string {
  const criteria = request.criteria
    .map(
      (criterion) =>
        `- ${criterion.id}${criterion.required === true ? " (required)" : ""}: ${criterion.description}`,
    )
    .join("\n");
  return [
    "You are grading work against a fixed rubric. Score each criterion from 0 (absent) to 1 (fully met).",
    "Grade only what the work shows. Do not reward claims the work does not support.",
    "",
    `Objective: ${request.objective}`,
    "Definition of done:",
    ...request.definitionOfDone.map((line) => `- ${line}`),
    "",
    "Criteria:",
    criteria,
    ...(request.instructions === undefined ? [] : ["", `Grader notes: ${request.instructions}`]),
    "",
    "Work to grade:",
    "<<<WORK",
    request.subject,
    "WORK>>>",
    "",
    "Reply with JSON only, matching this schema. For any score below 1, set `improvement` to the concrete change that would raise it.",
    JSON.stringify(goalJudgmentJsonSchema),
  ].join("\n");
}

// ---------------------------------------------------------------- trace

function countMatches(trace: readonly GoalTraceEntry[], matcher: GoalTraceActionMatcher): number {
  return trace.reduce(
    (count, traceEntry) => count + (matchesTraceEntry(matcher, traceEntry) ? 1 : 0),
    0,
  );
}

function runTrace(validator: GoalTraceValidatorSpec, trace: readonly GoalTraceEntry[]): ResultBody {
  const problems: string[] = [];
  const fixes: string[] = [];
  const observed: JsonObject[] = [];

  const required = validator.require ?? [];
  if (validator.ordered === true) {
    let cursor = 0;
    for (const matcher of required) {
      const needed = matcher.minCount ?? 1;
      let found = 0;
      let position = cursor;
      while (position < trace.length && found < needed) {
        const traceEntry = trace[position];
        if (traceEntry !== undefined && matchesTraceEntry(matcher, traceEntry)) {
          found += 1;
        }
        position += 1;
      }
      observed.push({ matcher: describeTraceMatcher(matcher), count: found });
      if (found < needed) {
        problems.push(
          `missing ${describeTraceMatcher(matcher)}${needed > 1 ? ` (${found} of ${needed})` : ""} after the previous required step`,
        );
        fixes.push(`do ${describeTraceMatcher(matcher)}`);
      } else {
        cursor = position;
      }
    }
  } else {
    for (const matcher of required) {
      const count = countMatches(trace, matcher);
      const minCount = matcher.minCount ?? 1;
      observed.push({ matcher: describeTraceMatcher(matcher), count });
      if (count < minCount) {
        problems.push(
          `missing ${describeTraceMatcher(matcher)}${minCount > 1 ? ` (${count} of ${minCount})` : ""}`,
        );
        fixes.push(`do ${describeTraceMatcher(matcher)}`);
      }
      if (matcher.maxCount !== undefined && count > matcher.maxCount) {
        problems.push(
          `${describeTraceMatcher(matcher)} happened ${count} times (at most ${matcher.maxCount})`,
        );
        fixes.push(`limit ${describeTraceMatcher(matcher)} to ${matcher.maxCount}`);
      }
    }
  }

  for (const matcher of validator.forbid ?? []) {
    const count = countMatches(trace, matcher);
    const allowed = matcher.maxCount ?? 0;
    observed.push({ matcher: describeTraceMatcher(matcher), count, forbidden: true });
    if (count > allowed) {
      problems.push(
        allowed === 0
          ? `forbidden action ${describeTraceMatcher(matcher)} happened ${count} time(s)`
          : `${describeTraceMatcher(matcher)} happened ${count} times (at most ${allowed})`,
      );
      fixes.push(
        allowed === 0
          ? `do not ${describeTraceMatcher(matcher)}`
          : `limit ${describeTraceMatcher(matcher)} to ${allowed}`,
      );
    }
  }

  if (problems.length === 0) {
    return {
      status: "passed",
      message: `All required actions appear in the trace (${trace.length} entries checked).`,
      details: { actions: observed },
    };
  }
  return {
    status: "failed",
    message: `Trace check failed: ${problems.join("; ")}.`,
    fix: `${capitalize(fixes.join("; "))}.`,
    details: { actions: observed },
  };
}

function checkProtectedPaths(
  protectedPaths: readonly string[],
  trace: readonly GoalTraceEntry[],
): GoalValidatorResult {
  const started = performance.now();
  const violations = findProtectedPathViolations(trace, protectedPaths);
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  if (violations.length === 0) {
    return Object.freeze({
      validatorId: PROTECTED_PATHS_VALIDATOR_ID,
      kind: "trace",
      required: true,
      status: "passed",
      message: "No writes to protected validator paths were found in the trace.",
      durationMs,
    });
  }
  return Object.freeze({
    validatorId: PROTECTED_PATHS_VALIDATOR_ID,
    kind: "trace",
    required: true,
    status: "failed",
    message: `The run tried to change protected validator files: ${violations
      .map((violation) => `${violation.path} via ${violation.toolName}`)
      .join(", ")}. Validators are fixed by the goal owner and cannot be edited.`,
    fix: "Restore the protected files and meet the goal by changing the work itself, not the checks.",
    details: {
      violations: violations.map((violation) => ({
        path: violation.path,
        toolName: violation.toolName,
        ...(violation.sequence === undefined ? {} : { sequence: violation.sequence }),
        ...(violation.eventId === undefined ? {} : { eventId: violation.eventId }),
      })),
    },
    durationMs,
  });
}

// ---------------------------------------------------------------- output schema

function runOutputSchema(
  validator: GoalOutputSchemaValidatorSpec,
  evidence: GoalEvidence,
): ResultBody {
  const subject = structuredSubject(evidence, validator.target);
  if (!subject.found) {
    return missingSubject(subject, validator.target);
  }
  const result = checkAgainstJsonSchema(validator.schema, subject.value);
  if (result.valid) {
    return {
      status: "passed",
      message: `${capitalize(targetLabel(validator.target))} matches the required schema.`,
    };
  }
  const shown = result.issues.slice(0, 10);
  return {
    status: "failed",
    message: `${capitalize(targetLabel(validator.target))} does not match the required schema: ${formatJsonSchemaIssues(shown)}${
      result.issues.length > shown.length
        ? ` (and ${result.issues.length - shown.length} more)`
        : ""
    }.`,
    fix: `Fix each listed field so ${targetLabel(validator.target)} matches the schema.`,
    details: {
      issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    },
  };
}

// ---------------------------------------------------------------- host checks

async function runCheck(
  validator: GoalCheckValidatorSpec,
  context: RunContext,
): Promise<ResultBody> {
  const checks = context.options.checks;
  const check: GoalCheck | undefined =
    checks !== undefined && Object.hasOwn(checks, validator.checkRef)
      ? checks[validator.checkRef]
      : undefined;
  if (check === undefined) {
    return {
      status: "error",
      message: `No check is registered as ${JSON.stringify(validator.checkRef)}; the host must supply one.`,
    };
  }
  const outcome = await withTimeout(
    (signal) =>
      check({
        goalId: context.spec.id,
        validatorId: validator.id,
        config: validator.config ?? {},
        evidence: context.evidence,
        signal,
      }),
    validator.timeoutMs ?? context.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    context.signal,
    `check ${validator.checkRef}`,
  );
  if (typeof outcome !== "object" || outcome === null || typeof outcome.passed !== "boolean") {
    return {
      status: "error",
      message: `Check ${validator.checkRef} returned no pass/fail outcome.`,
    };
  }
  const score =
    typeof outcome.score === "number" ? Math.min(1, Math.max(0, outcome.score)) : undefined;
  return {
    status: outcome.passed ? "passed" : "failed",
    message:
      outcome.message ??
      (outcome.passed
        ? `Check ${validator.checkRef} passed.`
        : `Check ${validator.checkRef} failed.`),
    ...(outcome.passed || outcome.fix === undefined ? {} : { fix: outcome.fix }),
    ...(outcome.observed === undefined ? {} : { observed: outcome.observed }),
    ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
    ...(score === undefined ? {} : { score }),
    ...(outcome.details === undefined ? {} : { details: outcome.details }),
  };
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => PromiseLike<T> | T,
  timeoutMs: number,
  parent: AbortSignal,
  label: string,
): Promise<T> {
  if (parent.aborted) {
    throw new Error(`${label} was cancelled before it started`);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject first so the timeout, not the abort it triggers, is reported.
          reject(new Error(`${label} timed out after ${timeoutMs} ms`));
          controller.abort(new Error(`${label} timed out`));
        }, timeoutMs);
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`${label} was cancelled`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    parent.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------- feedback

/**
 * Formats results as text for the agent. On failure it lists every blocking
 * check with what was observed and how to fix it; on success it says
 * `GOAL COMPLETE`.
 */
export function formatGoalFeedback(
  spec: GoalSpec,
  results: readonly GoalValidatorResult[],
): string {
  const blocking = results.filter((result) => result.required && result.status !== "passed");
  const advisory = results.filter((result) => !result.required && result.status !== "passed");
  const requiredCount = results.filter((result) => result.required).length;

  if (blocking.length === 0) {
    const lines = [`GOAL COMPLETE: ${spec.id}. All ${requiredCount} required check(s) passed.`];
    if (advisory.length > 0) {
      lines.push("Advisory checks that did not pass (not blocking):");
      lines.push(...advisory.map((result, index) => formatResultLine(result, index)));
    }
    return lines.join("\n");
  }

  const lines = [
    `GOAL INCOMPLETE: ${spec.id}. ${blocking.length} of ${requiredCount} required check(s) did not pass.`,
    ...blocking.map((result, index) => formatResultLine(result, index)),
  ];
  if (advisory.length > 0) {
    lines.push("Advisory (not blocking):");
    lines.push(...advisory.map((result, index) => formatResultLine(result, index)));
  }
  lines.push(
    "Keep working until every required check passes. The checks are fixed by the goal owner: change the work, not the checks.",
  );
  if (spec.protectedPaths !== undefined && spec.protectedPaths.length > 0) {
    lines.push(`Do not modify protected paths: ${spec.protectedPaths.join(", ")}.`);
  }
  return lines.join("\n");
}

function formatResultLine(result: GoalValidatorResult, index: number): string {
  const status = result.status === "error" ? "could not run" : result.status;
  const fix = result.fix === undefined ? "" : ` Fix: ${result.fix}`;
  return `${index + 1}. [${result.kind}] ${result.validatorId} ${status}: ${result.message}${fix}`;
}

/**
 * Renders the goal for the agent's prompt: the objective, the definition of
 * done, and the checks that will decide it. Thresholds are shown on purpose,
 * since the agent needs to know how it will be verified.
 */
export function describeGoalForAgent(goal: SealedGoal): string {
  const { spec } = goal;
  const lines = [
    `Goal ${spec.id}${spec.title === undefined ? "" : `: ${spec.title}`}`,
    `Objective: ${spec.objective}`,
    "Definition of done:",
    ...spec.definitionOfDone.map((line) => `- ${line}`),
    "Checks that decide completion:",
    ...spec.validators.map((validator) => `- ${describeValidator(validator)}`),
  ];
  if (spec.protectedPaths !== undefined && spec.protectedPaths.length > 0) {
    lines.push(`Protected paths you must not modify: ${spec.protectedPaths.join(", ")}.`);
  }
  lines.push("You are done only when every required check passes.");
  return lines.join("\n");
}

function describeValidator(validator: GoalValidatorSpec): string {
  const advisory = validator.required === false ? " (advisory)" : "";
  const description = validator.description === undefined ? "" : `: ${validator.description}`;
  switch (validator.kind) {
    case "numeric": {
      const source =
        "metric" in validator.source
          ? `metric ${validator.source.metric}`
          : `${validator.source.outputPath} in ${targetLabel(validator.source.target)}`;
      return `${validator.id}${advisory}${description} (${source} ${expectation(validator)})`;
    }
    case "rubric":
      return `${validator.id}${advisory}${description} (rubric on ${targetLabel(validator.target)}: ${validator.criteria
        .map((criterion) => criterion.description)
        .join("; ")})`;
    case "trace": {
      const required = (validator.require ?? []).map(describeTraceMatcher);
      const forbidden = (validator.forbid ?? []).map(describeTraceMatcher);
      const parts = [
        ...(required.length === 0
          ? []
          : [`must ${validator.ordered === true ? "in order " : ""}do: ${required.join(", ")}`]),
        ...(forbidden.length === 0 ? [] : [`must not: ${forbidden.join(", ")}`]),
      ];
      return `${validator.id}${advisory}${description} (${parts.join("; ")})`;
    }
    case "output_schema":
      return `${validator.id}${advisory}${description} (${targetLabel(validator.target)} must be JSON matching ${JSON.stringify(validator.schema)})`;
    case "check":
      return `${validator.id}${advisory}${description} (host check ${validator.checkRef})`;
  }
}
