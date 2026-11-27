import type {
  Awaitable,
  CanonicalEvent,
  GoalCheck,
  GoalEvidence,
  GoalJudge,
  GoalSpec,
  GoalValidationReport,
  GoalValidatorResult,
  GoalValidatorSpec,
  JsonValue,
  RunStoreContract,
  SealedGoal,
} from "@generic-ai/sdk";
import {
  GoalSpecError,
  goalTraceFromCanonicalEvents,
  parseActorDirectives,
  parseGoalSpec,
  runGoalValidators,
  sealGoal,
} from "@generic-ai/sdk";

import type { PersistentAgentRecord } from "./agents.js";
import type {
  AgentTaskGoal,
  AgentTaskGoalCheck,
  AgentTaskGoalReport,
  AgentTaskHandIn,
  AgentTaskRecord,
} from "./tasks.js";

/**
 * Goal gating for delegated tasks (roadmap R24 wired into R9).
 *
 * A task whose goal carries a `spec` only succeeds when the SDK validator
 * runner reports `COMPLETE`. The goal is sealed and fingerprinted when the
 * task is created and stored on the task record; every check re-seals it and
 * compares fingerprints, so a goal changed after submission is refused.
 * Judges and checks are host code registered here, never named by the agent.
 */
export interface TaskGoalOptions {
  /** Rubric judges by `judgeRef`; a bare function registers as `default`. */
  readonly judges?: GoalJudge | Readonly<Record<string, GoalJudge>>;
  /**
   * Judges for one task, chosen per agent so the judge can run on a different model from the
   * worker (decision 12). Wins over `judges` when it returns something.
   */
  readonly judgesFor?: (input: {
    readonly task: AgentTaskRecord;
    readonly agent: PersistentAgentRecord;
  }) => GoalJudge | Readonly<Record<string, GoalJudge>> | undefined;
  /**
   * Numbers the host measures for every hand-in, by metric name, with a line saying what each
   * counts. Shown to agents drafting a goal: numeric checks may only read these (decision 11).
   */
  readonly metrics?: Readonly<Record<string, string>>;
  /** Extra rules for goals agents draft with `set_goal`. Return a problem to refuse the draft. */
  readonly draftPolicy?: (
    spec: GoalSpec,
    input: { readonly task: AgentTaskRecord; readonly agent: PersistentAgentRecord },
  ) => string | undefined;
  /** Deterministic checks by `checkRef` (tests, CLIs, scripts). */
  readonly checks?: Readonly<Record<string, GoalCheck>>;
  readonly defaultTimeoutMs?: number;
  /** Extra evidence for a task turn, such as metrics or artifacts the host collected. */
  readonly evidence?: (input: TaskGoalEvidenceInput) => Awaitable<Partial<GoalEvidence>>;
}

export interface TaskGoalEvidenceInput {
  readonly task: AgentTaskRecord;
  readonly agent: PersistentAgentRecord;
  readonly outputText: string;
  /** Harness runs that executed this turn. */
  readonly turnRunIds: readonly string[];
  /** What the agent handed in with `submit_work`, when it used the tool. */
  readonly handIn?: AgentTaskHandIn;
}

/** Seals a task goal's spec and records its fingerprint. Throws `GoalSpecError` on an invalid spec. */
export function prepareTaskGoal(goal: AgentTaskGoal | undefined): AgentTaskGoal | undefined {
  if (goal?.spec === undefined) {
    return goal;
  }
  const sealed = sealGoal(goal.spec);
  return {
    ...goal,
    spec: sealed.spec,
    fingerprint: sealed.fingerprint,
    ...(goal.definitionOfDone === undefined && sealed.spec.definitionOfDone.length > 0
      ? { definitionOfDone: sealed.spec.definitionOfDone.join("\n") }
      : {}),
  };
}

/** Re-seals a stored goal and checks it still matches the fingerprint taken at creation. */
export function sealStoredGoal(goal: AgentTaskGoal | undefined): SealedGoal | undefined {
  if (goal?.spec === undefined) {
    return undefined;
  }
  const sealed = sealGoal(goal.spec);
  if (goal.fingerprint !== undefined && goal.fingerprint !== sealed.fingerprint) {
    throw new Error("The task's goal changed after it was created; refusing to validate it.");
  }
  return sealed;
}

/** Validates an untrusted goal spec from an agent's delegation. Returns an error message or the spec. */
export function readDelegatedGoalSpec(
  value: unknown,
): { readonly spec: AgentTaskGoal["spec"] } | { readonly error: string } {
  const parsed = parseGoalSpec(value);
  if (!parsed.ok) {
    return { error: new GoalSpecError(parsed.issues).message };
  }
  return { spec: parsed.value };
}

export async function collectGoalEvidence(
  runStore: Pick<RunStoreContract, "readEvents">,
  input: TaskGoalEvidenceInput,
  extra?: TaskGoalOptions["evidence"],
): Promise<GoalEvidence> {
  const events: CanonicalEvent[] = [];
  for (const runId of input.turnRunIds) {
    events.push(...(await runStore.readEvents(runId)));
  }
  const structured =
    input.handIn === undefined
      ? parseActorDirectives(input.outputText).data
      : (handInOutput(input.handIn) as JsonValue);
  const additional = (await extra?.(input)) ?? {};
  return {
    outputText: input.handIn?.summary ?? input.outputText,
    ...(structured === undefined ? {} : { output: structured }),
    trace: goalTraceFromCanonicalEvents(events),
    ...additional,
  };
}

export async function validateTaskGoal(
  sealed: SealedGoal,
  evidence: GoalEvidence,
  options: TaskGoalOptions & { readonly signal?: AbortSignal; readonly fingerprint?: string },
): Promise<GoalValidationReport> {
  return runGoalValidators(sealed, evidence, {
    ...(options.judges === undefined ? {} : { judges: options.judges }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fingerprint === undefined ? {} : { expectedFingerprint: options.fingerprint }),
  });
}

export function summarizeGoalReport(report: GoalValidationReport): AgentTaskGoalReport {
  return {
    status: report.status,
    goalId: report.goalId,
    fingerprint: report.goalFingerprint,
    required: report.summary.required,
    passed: report.summary.passed,
    failed: report.summary.failed,
    errored: report.summary.errored,
    feedback: report.feedback,
    evaluatedAt: report.evaluatedAt,
    checks: report.results.map(summarizeGoalCheck),
  };
}

function summarizeGoalCheck(result: GoalValidatorResult): AgentTaskGoalCheck {
  const criteria = result.details?.["criteria"];
  const perCriterion = Array.isArray(criteria)
    ? criteria.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return [];
        }
        const criterionId = entry["criterionId"];
        const passed = entry["passed"];
        const score = entry["score"];
        return typeof criterionId === "string" && typeof passed === "boolean"
          ? [{ criterionId, passed, ...(typeof score === "number" ? { score } : {}) }]
          : [];
      })
    : [];
  return {
    validatorId: result.validatorId,
    kind: result.kind,
    required: result.required,
    status: result.status,
    message: result.message.length > 500 ? `${result.message.slice(0, 499)}…` : result.message,
    ...(perCriterion.length === 0 ? {} : { criteria: perCriterion }),
  };
}

/** A hand-in as the structured output validators see: `{ summary, deliverables: [{ path, title? }] }`. */
export function handInOutput(handIn: AgentTaskHandIn): JsonValue {
  return {
    summary: handIn.summary,
    deliverables: handIn.deliverables.map((deliverable) => ({
      path: deliverable.path,
      ...(deliverable.title === undefined ? {} : { title: deliverable.title }),
    })),
  };
}

/** Id of the rubric the host keeps in step with the definition of done on owner edits. */
export const DEFINITION_OF_DONE_VALIDATOR_ID = "definition-of-done";

/**
 * Numeric checks read numbers the host measured, never numbers in the agent's own reply
 * (decision 11): a host metric, or a path into an artifact the host read itself (such as the
 * deliverable file). Returns a problem, or undefined.
 */
export function selfReportedNumberProblem(spec: GoalSpec): string | undefined {
  const offending = spec.validators.filter(
    (validator) =>
      validator.kind === "numeric" &&
      !("metric" in validator.source) &&
      !(validator.source.target ?? "output").startsWith("artifact:"),
  );
  if (offending.length === 0) {
    return undefined;
  }
  return (
    `Numeric checks must read a number the host measures ({"metric": "<name>"}, or an ` +
    `"outputPath" into an "artifact:<id>" target), not one from the agent's own reply: ${offending.map((validator) => validator.id).join(", ")}.`
  );
}

/**
 * Reads a goal an agent drafted with `set_goal`. The host fixes the id, so the agent cannot point
 * its task at another goal, and applies decision 11 and the host's own policy.
 */
export function readDraftedGoal(
  params: Record<string, unknown>,
  goalId: string,
  policy?: (spec: GoalSpec) => string | undefined,
): { readonly spec: GoalSpec } | { readonly error: string } {
  const definitionOfDone = params["definitionOfDone"];
  const candidate = {
    id: goalId,
    ...(typeof params["title"] === "string" ? { title: params["title"] } : {}),
    objective: params["objective"],
    definitionOfDone:
      typeof definitionOfDone === "string" ? [definitionOfDone] : (definitionOfDone ?? []),
    validators: params["validators"] ?? [],
  };
  const parsed = parseGoalSpec(candidate);
  if (!parsed.ok) {
    return { error: new GoalSpecError(parsed.issues).message };
  }
  const problem = selfReportedNumberProblem(parsed.value) ?? policy?.(parsed.value);
  return problem === undefined ? { spec: parsed.value } : { error: problem };
}

/** What the owner may change about a goal. Omitted fields stay as they are. */
export interface TaskGoalEdit {
  readonly objective?: string;
  readonly title?: string;
  readonly definitionOfDone?: readonly string[];
  /** Replaces the checks. Numeric checks must read host metrics. */
  readonly validators?: readonly GoalValidatorSpec[];
}

/**
 * Applies an owner edit to a goal. When the definition of done changes, the host's
 * `definition-of-done` rubric is rewritten (or added) so every line of the new version is
 * checked, not only the lines the original checks happened to cover (decision 8).
 */
export function applyGoalEdit(
  current: GoalSpec | undefined,
  edit: TaskGoalEdit,
  goalId: string,
  fallbackObjective: string,
): GoalSpec {
  const definitionOfDone = edit.definitionOfDone ?? current?.definitionOfDone ?? [];
  let validators: GoalValidatorSpec[] = [...(edit.validators ?? current?.validators ?? [])];
  if (edit.definitionOfDone !== undefined || validators.length === 0) {
    const rubric: GoalValidatorSpec = {
      id: DEFINITION_OF_DONE_VALIDATOR_ID,
      kind: "rubric",
      description: "Every line of the definition of done is met.",
      criteria: definitionOfDone.map((line, index) => ({
        id: `dod-${index + 1}`,
        description: line,
        required: true,
      })),
    };
    const existing = validators.findIndex(
      (validator) => validator.id === DEFINITION_OF_DONE_VALIDATOR_ID,
    );
    if (existing >= 0) {
      const previous = validators[existing] as GoalValidatorSpec;
      validators[existing] =
        previous.kind === "rubric" ? { ...previous, criteria: rubric.criteria } : rubric;
    } else if (definitionOfDone.length > 0) {
      validators = [...validators, rubric];
    }
  }
  const candidate = {
    ...(current ?? {}),
    id: current?.id ?? goalId,
    objective: edit.objective ?? current?.objective ?? fallbackObjective,
    ...(edit.title === undefined ? {} : { title: edit.title }),
    definitionOfDone,
    validators,
  };
  const parsed = parseGoalSpec(candidate);
  if (!parsed.ok) {
    throw new GoalSpecError(parsed.issues);
  }
  const problem = selfReportedNumberProblem(parsed.value);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  return parsed.value;
}
