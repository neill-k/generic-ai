import type { JsonObject, JsonValue } from "../contracts/shared.js";
import type { CanonicalEvent } from "../events/taxonomy.js";
import type {
  GoalSpec,
  GoalTraceEntry,
  GoalValidationReport,
  GoalValidatorKind,
  GoalValidatorSpec,
} from "../goals/types.js";

/**
 * Goal evals: replay goals, then score each attempt from its trace. An eval
 * answers "does the agent actually reach its goals, how reliably, and at what
 * cost", and its report feeds the reliability gate. See `docs/goal-evals.md`.
 */
export const GOAL_EVAL_SCHEMA_VERSION = "generic-ai.goal-eval/v1" as const;
export type GoalEvalSchemaVersion = typeof GOAL_EVAL_SCHEMA_VERSION;

/** One goal to replay. */
export interface GoalEvalCaseSpec {
  readonly id: string;
  readonly title?: string;
  /** The goal the agent is given. Its validators are visible to the agent. */
  readonly goal: GoalSpec;
  /**
   * Extra task text sent with the goal, for example input data or a persona.
   * The agent always also gets the goal's objective, definition of done, and
   * visible checks.
   */
  readonly instruction?: string;
  /**
   * Validators the agent never sees. They run after the attempt, against the
   * same evidence. An attempt that passes the visible checks but fails a
   * held-out one is a sign of teaching to the test.
   */
  readonly holdoutValidators?: readonly GoalValidatorSpec[];
  /**
   * Paths the agent must never touch, read or write: expected outputs, answer
   * keys, held-out fixtures. Any trace evidence of access is an integrity
   * violation and fails the attempt.
   */
  readonly hiddenPaths?: readonly string[];
  /** Static metrics merged under the metrics the trace provides. */
  readonly metrics?: Readonly<Record<string, number>>;
  readonly tags?: readonly string[];
  /** Overrides the suite's trial count for this case. */
  readonly trials?: number;
  readonly metadata?: JsonObject;
}

/** Thresholds an eval run must meet. The reliability gate reads `gate.passed`. */
export interface GoalEvalGateSpec {
  /** Minimum share of attempts that pass, across the suite. */
  readonly minPassRate?: number;
  /** Minimum pass^k for every case (probability that k attempts in a row all pass). */
  readonly minPassK?: number;
  /** Maximum tokens per completed goal, across the suite. */
  readonly maxTokensPerCompletedGoal?: number;
  /** Maximum dollars per completed goal, across the suite. */
  readonly maxCostPerCompletedGoalUsd?: number;
  /** Maximum integrity violations, across the suite. Defaults to 0. */
  readonly maxIntegrityViolations?: number;
  /** Minimum attempts per case for the gate to count. Defaults to 1. */
  readonly minTrialsPerCase?: number;
}

export interface GoalEvalSuiteSpec {
  readonly kind: "generic-ai.goal-eval-suite";
  readonly schemaVersion?: GoalEvalSchemaVersion;
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly cases: readonly GoalEvalCaseSpec[];
  readonly trials?: {
    /** Attempts per case. Defaults to 1. */
    readonly count?: number;
    /** pass^k horizon. Defaults to the attempt count. */
    readonly passK?: number;
  };
  readonly gate?: GoalEvalGateSpec;
  readonly metadata?: JsonObject;
}

/**
 * Everything captured from one attempt. Evals score from this record only, so
 * an attempt can be scored live, or later from a stored run's event log.
 */
export interface GoalEvalTrialRecord {
  readonly caseId: string;
  readonly trialId: string;
  readonly runId?: string;
  /** How the run itself ended. A run that failed to finish fails the attempt. */
  readonly runStatus?: "succeeded" | "failed" | "cancelled" | "blocked";
  readonly failureMessage?: string;
  readonly outputText?: string;
  readonly output?: JsonValue;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly metrics?: Readonly<Record<string, number>>;
  /**
   * The run's canonical events. Tool calls, usage, and in-run goal reports
   * are read from here.
   */
  readonly events?: readonly CanonicalEvent[];
  /** Extra trace entries, for example topology actor steps. */
  readonly trace?: readonly GoalTraceEntry[];
  /** Wall-clock duration of the attempt. */
  readonly durationMs?: number;
  /** Overrides the usage read from `events`, for runtimes that report it separately. */
  readonly usage?: GoalEvalUsage;
}

export interface GoalEvalUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly responses?: number;
  readonly budgetStopped?: boolean;
}

/** How one kind of check fared in an attempt. `score` is in [0, 1]. */
export interface GoalEvalCheckScore {
  readonly total: number;
  readonly passed: number;
  readonly score: number;
}

/**
 * The three NOVA checks (numeric outcomes, rubric grades, required actions in
 * the trace) plus the two structural kinds the goal contract adds.
 */
export type GoalEvalCheckScores = Readonly<Partial<Record<GoalValidatorKind, GoalEvalCheckScore>>>;

export const GOAL_EVAL_INTEGRITY_CODES = [
  "protected_path_write",
  "hidden_path_access",
  "goal_fingerprint_mismatch",
  "completion_claim_mismatch",
] as const;
export type GoalEvalIntegrityCode = (typeof GOAL_EVAL_INTEGRITY_CODES)[number];

/** Evidence that the agent tried to pass a check instead of meeting it. */
export interface GoalEvalIntegrityFinding {
  readonly code: GoalEvalIntegrityCode;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}

export interface GoalEvalTrialScore {
  readonly caseId: string;
  readonly trialId: string;
  readonly runId?: string;
  /** Visible validators passed, holdout validators passed, run finished, no integrity violation. */
  readonly passed: boolean;
  /** The visible goal report said COMPLETE. */
  readonly goalComplete: boolean;
  /** Holdout validators passed. `true` when the case has none. */
  readonly holdoutComplete: boolean;
  readonly runStatus: NonNullable<GoalEvalTrialRecord["runStatus"]>;
  readonly failureMessage?: string;
  readonly checks: GoalEvalCheckScores;
  readonly report: GoalValidationReport;
  readonly holdoutReport?: GoalValidationReport;
  readonly integrity: readonly GoalEvalIntegrityFinding[];
  /** Ids of required validators that did not pass, holdouts prefixed `holdout:`. */
  readonly failedValidators: readonly string[];
  readonly usage?: GoalEvalUsage;
  readonly durationMs?: number;
}

export interface GoalEvalPassK {
  readonly k: number;
  readonly passCount: number;
  readonly trialCount: number;
  /**
   * Estimated probability that k attempts in a row all pass. With n >= k
   * attempts this is C(passCount, k) / C(n, k); with fewer it is p^k.
   */
  readonly value: number;
}

export interface GoalEvalEfficiency {
  readonly totalTokens: number;
  readonly totalCostUsd: number | null;
  readonly completedGoals: number;
  /** All tokens spent, including on failed attempts, divided by passed attempts. */
  readonly tokensPerCompletedGoal: number | null;
  readonly costPerCompletedGoalUsd: number | null;
  readonly budgetStops: number;
  /** Attempts with no usage evidence. Their tokens are unknown, not zero. */
  readonly attemptsWithoutUsage: number;
}

/** A validator that keeps failing: where to add prompts, tools, or scripts next. */
export interface GoalEvalFinding {
  readonly caseId: string;
  readonly validatorId: string;
  readonly kind: GoalValidatorKind | "holdout" | "integrity" | "run";
  readonly failures: number;
  readonly trials: number;
  /** The most common failure message, as the agent saw it. */
  readonly message: string;
  readonly fix?: string;
}

export interface GoalEvalCaseSummary {
  readonly caseId: string;
  readonly title?: string;
  readonly goalId: string;
  readonly goalFingerprint: string;
  readonly trials: number;
  readonly passed: number;
  readonly passRate: number;
  readonly passK: GoalEvalPassK;
  readonly checks: GoalEvalCheckScores;
  readonly integrityViolations: number;
  readonly holdoutRegressions: number;
  readonly efficiency: GoalEvalEfficiency;
  readonly meanDurationMs: number | null;
}

export interface GoalEvalGateResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

export interface GoalEvalReport {
  readonly kind: "generic-ai.goal-eval-report";
  readonly schemaVersion: GoalEvalSchemaVersion;
  readonly suiteId: string;
  readonly title?: string;
  readonly generatedAt: string;
  readonly trials: number;
  readonly passed: number;
  readonly passRate: number;
  readonly checks: GoalEvalCheckScores;
  readonly integrityViolations: number;
  readonly efficiency: GoalEvalEfficiency;
  readonly cases: readonly GoalEvalCaseSummary[];
  /** Ranked by failure count: where evals say complexity should be added. */
  readonly findings: readonly GoalEvalFinding[];
  readonly gate: GoalEvalGateResult;
  readonly results: readonly GoalEvalTrialScore[];
}
