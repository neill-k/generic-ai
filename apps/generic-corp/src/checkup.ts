import { randomBytes } from "node:crypto";

import type { StorageContract } from "@generic-ai/sdk";

import type {
  BaselineConfigResult,
  BaselineEstimate,
  BaselinePlan,
  BaselineReport,
  BaselineSet,
  RunBaselineOptions,
} from "./baseline.js";
import type { CompanyModelAuth } from "./model-auth.js";
import { createSpendCap } from "./spend.js";

/**
 * The owner's checkup (design decision 45): the live baseline comparison, started only when the
 * owner presses "run the checkup". Nothing runs it on a schedule or from CI. Before it starts,
 * the owner sees what it will run and the tokens it is expected to use; the run stops at the
 * estimate's high end. One checkup runs at a time, in the background, and its report is kept in
 * host storage, which agents cannot reach.
 */
export interface CheckupPlanView {
  readonly plan: BaselinePlan;
  readonly estimate: BaselineEstimate;
  /** The plan and the expected usage, in words, for the confirmation step. */
  readonly description: string;
  /** False when a checkup cannot start now; `reason` says why. */
  readonly ready: boolean;
  readonly reason?: string;
}

export interface CheckupRun {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly startedBy?: string;
  readonly plan: {
    readonly templateId: string;
    readonly caseIds: readonly string[];
    readonly trials: number;
    readonly set: BaselineSet;
    readonly configs: readonly { readonly id: string; readonly label: string }[];
  };
  readonly estimate: BaselineEstimate;
  /** The configuration running now. */
  readonly running?: string;
  /** Configurations finished so far, with their numbers. */
  readonly finished: readonly Omit<BaselineConfigResult, "report">[];
  readonly headline?: string;
  readonly report?: BaselineReport;
  readonly markdown?: string;
  readonly error?: string;
}

export interface CompanyCheckup {
  /** What a checkup of this set would run, and its expected usage. */
  plan(set?: BaselineSet): Promise<CheckupPlanView>;
  /** Starts a checkup in the background. Throws `CheckupError` when one cannot start. */
  start(options?: { readonly set?: BaselineSet; readonly startedBy?: string }): Promise<CheckupRun>;
  get(id: string): Promise<CheckupRun | undefined>;
  /** Newest first. */
  list(options?: { readonly limit?: number }): Promise<readonly CheckupRun[]>;
  /** Resolves once no checkup is running. */
  idle(): Promise<void>;
}

export class CheckupError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "CheckupError";
  }
}

export const CHECKUP_NAMESPACE = "generic-corp-owner";
const COLLECTION = "checkups";
/** Only the newest checkups are kept. */
export const CHECKUPS_KEPT = 20;

export interface CreateCompanyCheckupOptions {
  readonly kv: StorageContract;
  /** The server's model sign-in; the checkup runs on the owner's own plan or key. */
  readonly modelAuth: CompanyModelAuth;
  readonly env?: NodeJS.ProcessEnv;
  /** Replaces the baseline runner, for tests. */
  readonly run?: (options: RunBaselineOptions) => Promise<BaselineReport>;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

const baseline = () => import("./baseline.js");

export function createCompanyCheckup(options: CreateCompanyCheckupOptions): CompanyCheckup {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  let current: { id: string; done: Promise<void> } | undefined;
  let starting = false;

  const save = async (run: CheckupRun) => {
    await options.kv.set({
      key: { namespace: CHECKUP_NAMESPACE, collection: COLLECTION, id: run.id },
      value: run,
      updatedAt: now().toISOString(),
    });
  };
  // A run stored as running that this process is not running was cut off by a restart.
  const settle = (run: CheckupRun): CheckupRun =>
    run.status === "running" && current?.id !== run.id
      ? { ...run, status: "failed", error: "The server stopped while this checkup was running." }
      : run;
  const all = async () =>
    (await options.kv.list({ namespace: CHECKUP_NAMESPACE, collection: COLLECTION }))
      .map((record) => settle(record.value as CheckupRun))
      .sort((left, right) => right.id.localeCompare(left.id));

  const plan = async (set: BaselineSet = "core"): Promise<CheckupPlanView> => {
    const { BASELINE_SETS, baselinePlan, describeBaselineEstimate, estimateBaseline } =
      await baseline();
    if (!Object.hasOwn(BASELINE_SETS, set)) {
      throw new CheckupError(
        400,
        `Unknown checkup set "${set}". Use ${Object.keys(BASELINE_SETS).join(" or ")}.`,
      );
    }
    const planned = baselinePlan({ set });
    const previous = (await all()).find((run) => run.report !== undefined)?.report;
    const estimate = estimateBaseline(planned, previous);
    const auth = await options.modelAuth.status();
    const reason =
      current !== undefined || starting
        ? "A checkup is already running."
        : auth.source === "none"
          ? "Agents have no model sign-in yet. Sign in with Claude or add an API key first."
          : undefined;
    return {
      plan: planned,
      estimate,
      description: describeBaselineEstimate(planned, estimate),
      ready: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    };
  };

  const begin = async (
    view: CheckupPlanView,
    startedBy: string | undefined,
  ): Promise<CheckupRun> => {
    const startedAt = now();
    const id = `${startedAt.getTime().toString().padStart(15, "0")}-${randomBytes(4).toString("hex")}`;
    let run: CheckupRun = {
      id,
      status: "running",
      startedAt: startedAt.toISOString(),
      ...(startedBy === undefined ? {} : { startedBy }),
      plan: {
        templateId: view.plan.templateId,
        caseIds: view.plan.caseIds,
        trials: view.plan.trials,
        set: view.plan.set,
        configs: view.plan.configs.map(({ id: configId, label }) => ({ id: configId, label })),
      },
      estimate: view.estimate,
      finished: [],
    };
    const update = async (patch: Partial<CheckupRun>) => {
      run = { ...run, ...patch };
      await save(run).catch((error: unknown) => {
        log(`Could not save checkup ${id}: ${error instanceof Error ? error.message : error}`);
      });
    };
    await save(run);
    const { renderBaselineMarkdown, runBaseline } = await baseline();
    const runner = options.run ?? runBaseline;
    log(`Checkup ${id} started: ${view.description.replace(/\n/g, " ")}`);
    const done = (async () => {
      try {
        const report = await runner({
          plan: view.plan,
          modelAuth: options.modelAuth,
          spendCap: createSpendCap({ maxTokens: view.estimate.maxTokens }),
          ...(options.env === undefined ? {} : { env: options.env }),
          onConfigStart: (config) => {
            void update({ running: config.id });
          },
          onConfigDone: ({ report: _report, ...numbers }) => {
            void update({ finished: [...run.finished, numbers] });
          },
          log,
        });
        const { running: _running, ...rest } = run;
        run = rest;
        await update({
          status: "succeeded",
          finishedAt: now().toISOString(),
          finished: report.configs.map(({ report: _report, ...numbers }) => numbers),
          headline: report.headline,
          report,
          markdown: renderBaselineMarkdown(report),
        });
        log(`Checkup ${id} finished. ${report.headline}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { running: _running, ...rest } = run;
        run = rest;
        await update({ status: "failed", finishedAt: now().toISOString(), error: message });
        log(`Checkup ${id} failed: ${message}`);
      } finally {
        current = undefined;
        const stale = (await all().catch(() => [])).slice(CHECKUPS_KEPT);
        for (const old of stale) {
          await options.kv.delete({
            namespace: CHECKUP_NAMESPACE,
            collection: COLLECTION,
            id: old.id,
          });
        }
      }
    })();
    current = { id, done };
    return run;
  };

  return {
    plan,
    async start(startOptions = {}) {
      const view = await plan(startOptions.set);
      if (!view.ready || starting) {
        throw new CheckupError(409, view.reason ?? "A checkup is already running.");
      }
      starting = true;
      try {
        return await begin(view, startOptions.startedBy);
      } finally {
        starting = false;
      }
    },
    async get(id) {
      const record = await options.kv.get<CheckupRun>({
        namespace: CHECKUP_NAMESPACE,
        collection: COLLECTION,
        id,
      });
      return record === undefined ? undefined : settle(record.value);
    },
    async list(listOptions = {}) {
      const limit = Math.max(1, Math.min(listOptions.limit ?? CHECKUPS_KEPT, CHECKUPS_KEPT));
      return (await all()).slice(0, limit);
    },
    async idle() {
      await current?.done;
    },
  };
}
