import type { Awaitable, JsonObject, JsonValue } from "../contracts/shared.js";

/**
 * Goal contracts: a goal is an objective plus a definition of done that can be
 * checked by machines. Validators are owned by the host that defines the goal,
 * never by the agent pursuing it. See `docs/goals.md`.
 */
export const GOAL_SPEC_SCHEMA_VERSION = "generic-ai.goal/v1" as const;
export type GoalSpecSchemaVersion = typeof GOAL_SPEC_SCHEMA_VERSION;

export const GOAL_VALIDATOR_KINDS = [
  "numeric",
  "rubric",
  "trace",
  "output_schema",
  "check",
] as const;
export type GoalValidatorKind = (typeof GOAL_VALIDATOR_KINDS)[number];

export const GOAL_NUMERIC_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "between"] as const;
export type GoalNumericOperator = (typeof GOAL_NUMERIC_OPERATORS)[number];

export const GOAL_TRACE_ACTION_STATUSES = ["started", "completed", "failed", "any"] as const;
export type GoalTraceActionStatus = (typeof GOAL_TRACE_ACTION_STATUSES)[number];

/**
 * Where a validator reads its subject from. `output` is the run's final
 * output. `artifact:<id>` is a named artifact supplied in the evidence.
 */
export type GoalTargetRef = "output" | `artifact:${string}`;

interface GoalValidatorBase {
  /** Unique within the goal. Appears in failure feedback. */
  readonly id: string;
  /** What this check proves, in words the agent can act on. */
  readonly description?: string;
  /**
   * Required validators gate completion. Advisory validators (`false`) are
   * reported but never block `COMPLETE`. Defaults to `true`.
   */
  readonly required?: boolean;
  /** Fixed remediation text appended to this validator's failure message. */
  readonly fixHint?: string;
  readonly metadata?: JsonObject;
}

/** Where a numeric validator reads its observed number from. */
export type GoalNumericSource =
  | { readonly metric: string }
  | {
      /** Dot path into the structured output, for example `summary.coverage`. */
      readonly outputPath: string;
      readonly target?: GoalTargetRef;
    };

export interface GoalNumericValidatorSpec extends GoalValidatorBase {
  readonly kind: "numeric";
  readonly source: GoalNumericSource;
  readonly operator: GoalNumericOperator;
  /** Threshold for every operator except `between`. */
  readonly value?: number;
  /** Inclusive bounds for `between`. */
  readonly min?: number;
  readonly max?: number;
  /** Absolute tolerance for `eq` and `neq`. Defaults to 0. */
  readonly tolerance?: number;
  readonly unit?: string;
}

export interface GoalRubricCriterion {
  readonly id: string;
  readonly description: string;
  /** Relative weight in the overall score. Defaults to 1. */
  readonly weight?: number;
  /** When true, this criterion must pass on its own regardless of the total. */
  readonly required?: boolean;
  /** Per-criterion pass score in [0, 1]. Defaults to the validator's threshold. */
  readonly passScore?: number;
}

/** Model-judged or human-judged rubric over a text subject. */
export interface GoalRubricValidatorSpec extends GoalValidatorBase {
  readonly kind: "rubric";
  readonly target?: GoalTargetRef;
  readonly criteria: readonly GoalRubricCriterion[];
  /** Weighted score in [0, 1] needed to pass. Defaults to 0.7. */
  readonly passThreshold?: number;
  /** Which registered judge to use. Defaults to `default`. */
  readonly judgeRef?: string;
  /** Extra instructions for the judge, for example domain context. */
  readonly judgeInstructions?: string;
  readonly timeoutMs?: number;
}

/** Matches entries in the run's trace. */
export interface GoalTraceActionMatcher {
  readonly id?: string;
  readonly description?: string;
  /** Tool name, for example `read_file` or `bash`. */
  readonly tool?: string;
  /** Event type, for example `tool.call.completed` or `handoff.completed`. */
  readonly event?: string;
  /** Role or actor that must have performed the action. */
  readonly role?: string;
  /** Lifecycle status of tool events. Defaults to `completed` when `tool` is set. */
  readonly status?: GoalTraceActionStatus;
  /** Every key here must deep-equal the same key in the entry's tool args. */
  readonly argsInclude?: JsonObject;
  /** Defaults to 1 for `require`, 0 (never) for `forbid`. */
  readonly minCount?: number;
  readonly maxCount?: number;
}

/** Asserts that required actions happened (or forbidden ones did not). */
export interface GoalTraceValidatorSpec extends GoalValidatorBase {
  readonly kind: "trace";
  readonly require?: readonly GoalTraceActionMatcher[];
  readonly forbid?: readonly GoalTraceActionMatcher[];
  /** When true, `require` matchers must be satisfied in the listed order. */
  readonly ordered?: boolean;
}

/** Checks a structured (JSON) subject against a JSON Schema subset. */
export interface GoalOutputSchemaValidatorSpec extends GoalValidatorBase {
  readonly kind: "output_schema";
  readonly target?: GoalTargetRef;
  readonly schema: JsonObject;
}

/**
 * A deterministic check registered by the host: a test suite, a CLI, a
 * script. The goal only names it; the host supplies the implementation, so
 * the agent cannot change what the check does.
 */
export interface GoalCheckValidatorSpec extends GoalValidatorBase {
  readonly kind: "check";
  readonly checkRef: string;
  readonly config?: JsonObject;
  readonly timeoutMs?: number;
}

export type GoalValidatorSpec =
  | GoalNumericValidatorSpec
  | GoalRubricValidatorSpec
  | GoalTraceValidatorSpec
  | GoalOutputSchemaValidatorSpec
  | GoalCheckValidatorSpec;

export interface GoalSpec {
  readonly schemaVersion?: GoalSpecSchemaVersion;
  readonly id: string;
  readonly title?: string;
  /** What the agent is asked to achieve. */
  readonly objective: string;
  /** Plain statements of what "done" means, shown to the agent. */
  readonly definitionOfDone: readonly string[];
  /** The machine checks that decide whether the definition of done is met. */
  readonly validators: readonly GoalValidatorSpec[];
  /**
   * Workspace paths (exact files or directory prefixes ending in `/`) that
   * hold validator scripts, fixtures, or expected outputs. Any trace evidence
   * of the agent writing to them fails the goal.
   */
  readonly protectedPaths?: readonly string[];
  /** Advisory cap on validate-and-retry rounds for the runner that wires this in. */
  readonly maxAttempts?: number;
  readonly metadata?: JsonObject;
}

/**
 * A goal that has been checked, deep-frozen, and fingerprinted. Only
 * `sealGoal` creates these; the runner refuses anything else.
 */
export interface SealedGoal {
  readonly kind: "sealed-goal";
  readonly spec: GoalSpec;
  /** sha256 over the canonical JSON of `spec`. */
  readonly fingerprint: string;
}

/** One normalized entry of a run's trace. */
export interface GoalTraceEntry {
  readonly sequence?: number;
  /** Event type, for example `tool.call.completed`. */
  readonly type: string;
  readonly toolName?: string;
  readonly roleId?: string;
  readonly args?: JsonObject;
  readonly isError?: boolean;
  readonly eventId?: string;
}

/** Everything the agent produced that validators may inspect. */
export interface GoalEvidence {
  readonly outputText?: string;
  /** Structured output. When absent, `outputText` is parsed as JSON on demand. */
  readonly output?: JsonValue;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly trace?: readonly GoalTraceEntry[];
  /** Named artifacts as text, addressed by `artifact:<id>`. */
  readonly artifacts?: Readonly<Record<string, string>>;
}

export type GoalValidatorStatus = "passed" | "failed" | "error";

export interface GoalValidatorResult {
  readonly validatorId: string;
  readonly kind: GoalValidatorKind;
  readonly required: boolean;
  readonly status: GoalValidatorStatus;
  /** What happened, phrased for the agent. */
  readonly message: string;
  /** How to fix it, when the validator can say. */
  readonly fix?: string;
  readonly observed?: JsonValue;
  readonly expected?: JsonValue;
  /** Normalized score in [0, 1] for rubric and scored checks. */
  readonly score?: number;
  readonly details?: JsonObject;
  readonly durationMs: number;
}

export type GoalValidationStatus = "COMPLETE" | "INCOMPLETE";

export interface GoalValidationReport {
  readonly kind: "goal-validation-report";
  readonly goalId: string;
  readonly goalFingerprint: string;
  readonly status: GoalValidationStatus;
  readonly complete: boolean;
  readonly results: readonly GoalValidatorResult[];
  readonly summary: {
    readonly required: number;
    readonly passed: number;
    readonly failed: number;
    readonly errored: number;
    readonly advisoryFailed: number;
  };
  /** Ready-to-send text telling the agent what failed and how to fix it. */
  readonly feedback: string;
  readonly evaluatedAt: string;
}

export interface GoalRubricJudgeRequest {
  readonly goalId: string;
  readonly validatorId: string;
  readonly objective: string;
  readonly definitionOfDone: readonly string[];
  readonly criteria: readonly GoalRubricCriterion[];
  readonly subject: string;
  readonly instructions?: string;
  readonly signal: AbortSignal;
}

export interface GoalCriterionJudgment {
  readonly criterionId: string;
  /** Score in [0, 1]. */
  readonly score: number;
  readonly rationale?: string;
  /** What would raise the score. Surfaced to the agent on failure. */
  readonly improvement?: string;
}

/** Structured judge output; see `goalJudgmentJsonSchema`. */
export interface GoalJudgment {
  readonly criteria: readonly GoalCriterionJudgment[];
  readonly summary?: string;
}

export type GoalJudge = (request: GoalRubricJudgeRequest) => Awaitable<GoalJudgment>;

export interface GoalCheckInput {
  readonly goalId: string;
  readonly validatorId: string;
  readonly config: JsonObject;
  readonly evidence: GoalEvidence;
  readonly signal: AbortSignal;
}

export interface GoalCheckOutcome {
  readonly passed: boolean;
  readonly message?: string;
  readonly fix?: string;
  readonly observed?: JsonValue;
  readonly expected?: JsonValue;
  readonly score?: number;
  readonly details?: JsonObject;
}

export type GoalCheck = (input: GoalCheckInput) => Awaitable<GoalCheckOutcome>;

export interface RunGoalValidatorsOptions {
  /** Rubric judges by `judgeRef`. A bare function registers as `default`. */
  readonly judges?: GoalJudge | Readonly<Record<string, GoalJudge>>;
  /** Host-owned deterministic checks by `checkRef`. */
  readonly checks?: Readonly<Record<string, GoalCheck>>;
  readonly signal?: AbortSignal;
  /** Timeout for judge and check validators without their own. Defaults to 120000. */
  readonly defaultTimeoutMs?: number;
  readonly now?: () => Date;
}
