import type { RunStoreContract } from "../contracts/run-store.js";
import type { JsonValue } from "../contracts/shared.js";
import { describeGoalForAgent } from "../goals/runner.js";
import type { RunGoalValidatorsOptions } from "../goals/types.js";
import { type ScoreGoalEvalTrialOptions, scoreGoalEvalTrial } from "./score.js";
import { goalEvalTrialCount, type SealedGoalEvalCase, sealGoalEvalCase } from "./suite.js";
import { type SummarizeGoalEvalOptions, summarizeGoalEval } from "./summarize.js";
import type {
  GoalEvalCaseSpec,
  GoalEvalReport,
  GoalEvalSuiteSpec,
  GoalEvalTrialRecord,
  GoalEvalTrialScore,
} from "./types.js";

/** One attempt the eval asks an executor to make. */
export interface GoalEvalAttempt {
  readonly suite: GoalEvalSuiteSpec;
  readonly caseSpec: GoalEvalCaseSpec;
  /** Sealed goals. Only `goal` is shown to the agent; `holdout` stays with the eval. */
  readonly sealed: SealedGoalEvalCase;
  readonly trialId: string;
  /** 0-based attempt index within the case. */
  readonly trialIndex: number;
  /** Ready-to-send prompt: the goal, its visible checks, and the case instruction. */
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** What an executor returns. The eval fills in the case and attempt ids. */
export type GoalEvalExecution = Omit<GoalEvalTrialRecord, "caseId" | "trialId">;

/**
 * Runs the agent (or a topology of agents) on one attempt and returns what it
 * produced, with its canonical events. Executors must not share state between
 * attempts, or pass^k stops meaning anything.
 */
export type GoalEvalExecutor = (attempt: GoalEvalAttempt) => Promise<GoalEvalExecution>;

export interface RunGoalEvalSuiteOptions
  extends Pick<RunGoalValidatorsOptions, "judges" | "checks" | "defaultTimeoutMs">,
    SummarizeGoalEvalOptions {
  readonly suite: GoalEvalSuiteSpec;
  readonly execute: GoalEvalExecutor;
  /** Only run these case ids. */
  readonly caseIds?: readonly string[];
  /** Attempts running at once. Defaults to 1. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onTrialScored?: (score: GoalEvalTrialScore) => void | Promise<void>;
}

/** The prompt an eval attempt sends: the goal as the agent sees it, plus the case instruction. */
export function buildGoalEvalPrompt(sealed: SealedGoalEvalCase): string {
  const instruction = sealed.caseSpec.instruction?.trim();
  return [
    describeGoalForAgent(sealed.goal),
    ...(instruction === undefined || instruction.length === 0 ? [] : ["", instruction]),
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as TItem);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Replays every case of a suite through an executor, scores each attempt from
 * its trace, and returns the report. An executor that throws counts as a
 * failed attempt, never as a crash of the eval.
 */
export async function runGoalEvalSuite(options: RunGoalEvalSuiteOptions): Promise<GoalEvalReport> {
  const { suite } = options;
  const selected =
    options.caseIds === undefined
      ? suite.cases
      : suite.cases.filter((caseSpec) => options.caseIds?.includes(caseSpec.id));
  const attempts: GoalEvalAttempt[] = [];
  for (const caseSpec of selected) {
    const sealed = sealGoalEvalCase(caseSpec);
    const prompt = buildGoalEvalPrompt(sealed);
    const count = goalEvalTrialCount(suite, caseSpec);
    for (let trialIndex = 0; trialIndex < count; trialIndex += 1) {
      attempts.push({
        suite,
        caseSpec,
        sealed,
        trialId: `${caseSpec.id}:trial:${trialIndex + 1}`,
        trialIndex,
        prompt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
  }

  const scoreOptions = (sealed: SealedGoalEvalCase): ScoreGoalEvalTrialOptions => ({
    sealed,
    ...(options.judges === undefined ? {} : { judges: options.judges }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const scores = await mapWithConcurrency(attempts, options.concurrency ?? 1, async (attempt) => {
    const startedAt = Date.now();
    let execution: GoalEvalExecution;
    try {
      execution = await options.execute(attempt);
    } catch (error) {
      execution = { runStatus: "failed", failureMessage: errorMessage(error) };
    }
    const record: GoalEvalTrialRecord = {
      ...execution,
      caseId: attempt.caseSpec.id,
      trialId: attempt.trialId,
      durationMs: execution.durationMs ?? Date.now() - startedAt,
    };
    const score = await scoreGoalEvalTrial(attempt.caseSpec, record, scoreOptions(attempt.sealed));
    await options.onTrialScored?.(score);
    return score;
  });

  const scopedSuite =
    options.caseIds === undefined ? suite : { ...suite, cases: Object.freeze([...selected]) };
  return summarizeGoalEval(scopedSuite, scores, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function outputTextOf(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["outputText", "text", "content"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Builds an eval record from a run already in the durable store, so goals can
 * be scored after the fact from production traces.
 */
export async function goalEvalRecordFromRunStore(
  store: Pick<RunStoreContract, "getRun" | "readEvents">,
  runId: string,
  ids: { readonly caseId: string; readonly trialId?: string },
): Promise<GoalEvalTrialRecord> {
  const run = await store.getRun(runId);
  if (run === undefined) {
    throw new Error(`Run "${runId}" is not in the run store.`);
  }
  const events = await store.readEvents(runId);
  const status = run.envelope.status;
  const payload = run.envelope.output?.payload;
  const outputText = outputTextOf(payload) ?? run.envelope.output?.summary;
  const started = run.envelope.timestamps.startedAt ?? run.envelope.timestamps.createdAt;
  const completed = run.envelope.timestamps.completedAt;
  const durationMs =
    completed === undefined ? undefined : Date.parse(completed) - Date.parse(started);
  return Object.freeze({
    caseId: ids.caseId,
    trialId: ids.trialId ?? runId,
    runId,
    runStatus:
      status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed",
    ...(status === "created" || status === "running"
      ? { failureMessage: `Run is still ${status}.` }
      : {}),
    ...(outputText === undefined ? {} : { outputText }),
    ...(payload !== undefined && payload !== null && outputTextOf(payload) === undefined
      ? { output: payload as JsonValue }
      : {}),
    events,
    ...(durationMs === undefined || Number.isNaN(durationMs) ? {} : { durationMs }),
  });
}
