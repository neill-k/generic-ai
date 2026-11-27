import type { Model } from "@generic-ai/ai";
import {
  type GoalEvalReport,
  type GoalJudge,
  renderGoalEvalMarkdown,
  runGoalEvalSuite,
} from "@generic-ai/sdk";

import { type CompanyConfig, ceoOf, modelFor } from "./company.js";
import { cappedJudge, createCompanyEvalExecutor } from "./evals.js";
import { createModelJudge } from "./goals.js";
import type { CompanyModelAuth } from "./model-auth.js";
import { secondOpinionModel } from "./second-opinion.js";
import { createSpendCap, type SpendCap } from "./spend.js";
import { loadTemplateEvalSuite, type TemplateEvalSuite } from "./templates.js";

/**
 * The baseline comparison (design decisions 43 to 45): the same goals run through a plain single
 * agent and through Generic Corp, with each of the company's features switchable, and every
 * configuration reports tokens per finished goal. NOVA promises a 90% cut; this measures it.
 *
 * Results are judged on what was delivered, never on who did the work (decision 44), so every
 * configuration runs the same goal with the same validators and the same judge.
 *
 * Live runs only start when the owner asks: `npm run checkup` locally, or the checkup button
 * (`POST /api/checkup`). Tests run it on a scripted model.
 */
export const BASELINE_FEATURES = ["delegation", "offload", "rlm", "memory"] as const;
export type BaselineFeature = (typeof BASELINE_FEATURES)[number];
export type BaselineFeatures = Readonly<Record<BaselineFeature, boolean>>;

export const BASELINE_FEATURE_LABELS: Readonly<Record<BaselineFeature, string>> = Object.freeze({
  delegation: "delegation to a team",
  offload: "offloading large tool results to files",
  rlm: "the Python workspace (RLM)",
  memory: "agent memory files",
});

export interface BaselineConfig {
  readonly id: string;
  readonly label: string;
  readonly features: BaselineFeatures;
}

const ALL_ON: BaselineFeatures = { delegation: true, offload: true, rlm: true, memory: true };

/** The plain single agent everything is compared against: one agent, every feature off. */
export const SINGLE_AGENT_CONFIG: BaselineConfig = Object.freeze({
  id: "single-agent",
  label: "Plain single agent",
  features: { delegation: false, offload: false, rlm: false, memory: false },
});

/** Generic Corp as it ships: the whole team with every feature on. */
export const COMPANY_CONFIG: BaselineConfig = Object.freeze({
  id: "company",
  label: "Generic Corp, everything on",
  features: ALL_ON,
});

/** Generic Corp with one feature off at a time, to show what each one is worth. */
export const ABLATION_CONFIGS: readonly BaselineConfig[] = Object.freeze(
  BASELINE_FEATURES.map((feature) => ({
    id: `company-no-${feature}`,
    label: `Generic Corp without ${BASELINE_FEATURE_LABELS[feature]}`,
    features: { ...ALL_ON, [feature]: false },
  })),
);

export const BASELINE_CONFIGS: readonly BaselineConfig[] = Object.freeze([
  SINGLE_AGENT_CONFIG,
  COMPANY_CONFIG,
  ...ABLATION_CONFIGS,
]);

/** `core` answers the headline question; `ablation` adds one run per feature switched off. */
export const BASELINE_SETS = Object.freeze({
  core: [SINGLE_AGENT_CONFIG.id, COMPANY_CONFIG.id],
  ablation: BASELINE_CONFIGS.map((config) => config.id),
}) satisfies Readonly<Record<string, readonly string[]>>;
export type BaselineSet = keyof typeof BASELINE_SETS;

/**
 * The live set is kept small because the owner pays for it from their Claude plan: one goal with
 * exact answers (no web search, so nothing outside the run changes the result), one attempt.
 */
export const DEFAULT_BASELINE_TEMPLATE = "back-office";
export const DEFAULT_BASELINE_CASES: readonly string[] = Object.freeze(["month-end-close"]);
export const DEFAULT_BASELINE_TRIALS = 1;

/**
 * Tokens one attempt is expected to use, cache reads included, before anything has been measured.
 * These are guesses; once a checkup has run, its real numbers replace them.
 */
export const GUESSED_TOKENS_PER_ATTEMPT: Readonly<
  Record<"single" | "team", { readonly low: number; readonly high: number }>
> = Object.freeze({
  single: { low: 150_000, high: 600_000 },
  team: { low: 300_000, high: 1_500_000 },
});

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

export function baselineConfig(id: string): BaselineConfig {
  const config = BASELINE_CONFIGS.find((candidate) => candidate.id === id);
  if (config === undefined) {
    throw new BaselineError(
      `Unknown baseline configuration "${id}". Known: ${BASELINE_CONFIGS.map((c) => c.id).join(", ")}.`,
    );
  }
  return config;
}

export function baselineConfigsFor(set: BaselineSet): readonly BaselineConfig[] {
  return BASELINE_SETS[set].map(baselineConfig);
}

/**
 * The company a configuration runs. With delegation off it is one agent, the CEO, told to do every
 * part of the work itself and given what each role in the template knows, so the comparison is
 * about structure, not about missing know-how.
 */
export function baselineCompany(company: CompanyConfig, features: BaselineFeatures): CompanyConfig {
  if (features.delegation) {
    return company;
  }
  const ceo = ceoOf(company);
  const others = company.agents.filter((agent) => agent.id !== ceo.id);
  const expertise = others
    .filter((agent) => (agent.instructions ?? "").trim().length > 0)
    .map((agent) => `- As ${agent.title ?? agent.role}: ${agent.instructions?.trim()}`);
  const instructions = [
    "You work alone: there is no team, so do every part of the work yourself. Where the text below mentions colleagues, do their part yourself.",
    ...(ceo.instructions === undefined ? [] : ["", ceo.instructions.trim()]),
    ...(expertise.length === 0
      ? []
      : ["", "What each role in a full team would know:", ...expertise]),
  ].join("\n");
  const secrets = [...new Set(company.agents.flatMap((agent) => agent.secrets ?? []))];
  return {
    ...company,
    agents: [
      {
        ...ceo,
        instructions,
        // The single agent stays on the CEO's model, so only the structure changes.
        model: modelFor(company, ceo.id),
        ...(secrets.length === 0 ? {} : { secrets }),
      },
    ],
  };
}

export interface BaselineEstimate {
  readonly attempts: number;
  /** Expected tokens for the whole run, cache reads included. */
  readonly lowTokens: number;
  readonly highTokens: number;
  /** `measured` when the numbers come from an earlier run, `guess` before one has run. */
  readonly basis: "measured" | "guess";
  /** The hard token cap the run stops at. */
  readonly maxTokens: number;
  readonly configs: readonly {
    readonly id: string;
    readonly lowTokens: number;
    readonly highTokens: number;
  }[];
}

export interface BaselinePlan {
  readonly templateId: string;
  readonly caseIds: readonly string[];
  readonly trials: number;
  readonly set: BaselineSet;
  readonly configs: readonly BaselineConfig[];
}

export function baselinePlan(
  options: {
    readonly templateId?: string;
    readonly caseIds?: readonly string[];
    readonly trials?: number;
    readonly set?: BaselineSet;
  } = {},
): BaselinePlan {
  const set = options.set ?? "core";
  return {
    templateId: options.templateId ?? DEFAULT_BASELINE_TEMPLATE,
    caseIds: options.caseIds ?? DEFAULT_BASELINE_CASES,
    trials: options.trials ?? DEFAULT_BASELINE_TRIALS,
    set,
    configs: baselineConfigsFor(set),
  };
}

/**
 * What a run is expected to use. A previous report gives measured tokens per attempt for each
 * configuration it ran, with a 50% margin either way; configurations it lacks use the guesses.
 * The token cap is the high end, so a run never spends more than the owner was shown.
 */
export function estimateBaseline(
  plan: BaselinePlan,
  previous?: Pick<BaselineReport, "configs">,
): BaselineEstimate {
  const attemptsPerConfig = plan.caseIds.length * plan.trials;
  let measured = 0;
  const configs = plan.configs.map((config) => {
    const before = previous?.configs.find((result) => result.id === config.id);
    const run = before === undefined ? 0 : before.attempts - before.notRun;
    if (before !== undefined && run > 0 && before.totalTokens > 0) {
      measured += 1;
      const perAttempt = before.totalTokens / run;
      return {
        id: config.id,
        lowTokens: Math.round(perAttempt * 0.5 * attemptsPerConfig),
        highTokens: Math.round(perAttempt * 1.5 * attemptsPerConfig),
      };
    }
    const guess = GUESSED_TOKENS_PER_ATTEMPT[config.features.delegation ? "team" : "single"];
    return {
      id: config.id,
      lowTokens: guess.low * attemptsPerConfig,
      highTokens: guess.high * attemptsPerConfig,
    };
  });
  const lowTokens = configs.reduce((sum, config) => sum + config.lowTokens, 0);
  const highTokens = configs.reduce((sum, config) => sum + config.highTokens, 0);
  return {
    attempts: attemptsPerConfig * plan.configs.length,
    lowTokens,
    highTokens,
    basis: measured === configs.length && configs.length > 0 ? "measured" : "guess",
    maxTokens: highTokens,
    configs,
  };
}

export interface BaselineConfigResult {
  readonly id: string;
  readonly label: string;
  readonly features: BaselineFeatures;
  readonly attempts: number;
  readonly passed: number;
  /** Attempts not started because the token cap was reached. They count as failures. */
  readonly notRun: number;
  readonly totalTokens: number;
  /** Every token the configuration spent, failed attempts included, per goal it finished. */
  readonly tokensPerFinishedGoal: number | null;
  readonly costUsd: number | null;
  /** Attempts with no usage evidence; their tokens are unknown, not zero. */
  readonly attemptsWithoutUsage: number;
  /** `1 - tokensPerFinishedGoal / single agent's`, or null when either finished nothing. */
  readonly reductionVsSingleAgent: number | null;
  readonly report: GoalEvalReport;
}

export interface BaselineReport {
  readonly kind: "generic-ai.baseline-report";
  readonly generatedAt: string;
  readonly templateId: string;
  readonly caseIds: readonly string[];
  readonly trials: number;
  readonly set: BaselineSet;
  readonly configs: readonly BaselineConfigResult[];
  /** One sentence answering "did Generic Corp cut tokens per finished goal, and by how much". */
  readonly headline: string;
  readonly spent: { readonly tokens: number; readonly costUsd: number; readonly responses: number };
  readonly maxTokens?: number;
  /** Why the run stopped early, when the token cap was reached. */
  readonly capReason?: string;
}

/** The share NOVA promises, as a fraction. */
export const NOVA_CLAIMED_REDUCTION = 0.9;

export interface RunBaselineOptions {
  readonly plan?: BaselinePlan;
  /** Replaces the loaded template, for tests. */
  readonly template?: TemplateEvalSuite;
  readonly env?: NodeJS.ProcessEnv;
  /** Where agents and the judge get their model credential, for example the owner's Claude sign-in. */
  readonly modelAuth?: CompanyModelAuth;
  /** Replaces the model resolver, for tests. */
  readonly resolveModel?: (ref: string) => Model;
  /** Replaces the model judge, for tests. */
  readonly judge?: GoalJudge;
  /** Defaults to a token cap at the estimate's high end. */
  readonly spendCap?: SpendCap;
  readonly onConfigStart?: (config: BaselineConfig) => void;
  readonly onConfigDone?: (result: BaselineConfigResult) => void;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

/**
 * Runs every configuration of the plan, one after another, on fresh companies. Each attempt
 * starts in a new data directory, so memory starts empty and no run helps the next.
 */
export async function runBaseline(options: RunBaselineOptions = {}): Promise<BaselineReport> {
  const plan = options.plan ?? baselinePlan();
  const template = options.template ?? (await loadTemplateEvalSuite(plan.templateId));
  const missing = plan.caseIds.filter(
    (caseId) => !template.suite.cases.some((testCase) => testCase.id === caseId),
  );
  if (missing.length > 0) {
    throw new BaselineError(
      `Template ${plan.templateId} has no eval case ${missing.join(", ")}. Cases: ${template.suite.cases.map((c) => c.id).join(", ")}.`,
    );
  }
  const spendCap =
    options.spendCap ?? createSpendCap({ maxTokens: estimateBaseline(plan).maxTokens });
  const suite = {
    ...template.suite,
    trials: { ...template.suite.trials, count: plan.trials, passK: 1 },
    cases: template.suite.cases.map(({ trials: _trials, ...rest }) => rest),
  };
  // One judge for every configuration, on a model other than the CEO's (decision 12).
  const judgeModel = secondOpinionModel(
    template.company,
    modelFor(template.company, ceoOf(template.company).id),
  );
  const judge = cappedJudge(
    options.judge ??
      createModelJudge({
        model: judgeModel,
        ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
        ...(options.modelAuth === undefined
          ? {}
          : { getAuth: options.modelAuth.getAuth.bind(options.modelAuth) }),
        onUsage: (usage) => spendCap.recordModelUsage(usage),
      }),
    spendCap,
  );

  const results: BaselineConfigResult[] = [];
  for (const config of plan.configs) {
    options.onConfigStart?.(config);
    options.log?.(`Baseline: running ${config.label}.`);
    let notRun = 0;
    const report = await runGoalEvalSuite({
      suite,
      caseIds: plan.caseIds,
      execute: createCompanyEvalExecutor({
        company: baselineCompany(template.company, config.features),
        mode: "live",
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
        ...(options.modelAuth === undefined ? {} : { modelAuth: options.modelAuth }),
        features: {
          offload: config.features.offload,
          rlm: config.features.rlm,
          memory: config.features.memory,
        },
        judge,
        spendCap,
        onSkipped: () => {
          notRun += 1;
        },
        ...(options.log === undefined ? {} : { log: options.log }),
      }),
      judges: judge,
    });
    const result = configResult(config, report, notRun);
    results.push(result);
    options.onConfigDone?.(result);
  }

  const baseline = results.find((result) => result.id === SINGLE_AGENT_CONFIG.id);
  const configs = results.map((result) => ({
    ...result,
    reductionVsSingleAgent: reduction(result, baseline),
  }));
  const spent = spendCap.spent();
  const capReason = spendCap.reason();
  return {
    kind: "generic-ai.baseline-report",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    templateId: plan.templateId,
    caseIds: plan.caseIds,
    trials: plan.trials,
    set: plan.set,
    configs,
    headline: headline(configs),
    spent: { tokens: spent.totalTokens, costUsd: spent.costUsd, responses: spent.responses },
    ...(spendCap.limits.maxTokens === undefined ? {} : { maxTokens: spendCap.limits.maxTokens }),
    ...(capReason === undefined ? {} : { capReason }),
  };
}

function configResult(
  config: BaselineConfig,
  report: GoalEvalReport,
  notRun: number,
): BaselineConfigResult {
  return {
    id: config.id,
    label: config.label,
    features: config.features,
    attempts: report.trials,
    passed: report.passed,
    notRun,
    totalTokens: report.efficiency.totalTokens,
    tokensPerFinishedGoal: report.efficiency.tokensPerCompletedGoal,
    costUsd: report.efficiency.totalCostUsd,
    attemptsWithoutUsage: report.efficiency.attemptsWithoutUsage,
    reductionVsSingleAgent: null,
    report,
  };
}

function reduction(
  result: BaselineConfigResult,
  baseline: BaselineConfigResult | undefined,
): number | null {
  if (
    baseline === undefined ||
    result.id === baseline.id ||
    result.tokensPerFinishedGoal === null ||
    baseline.tokensPerFinishedGoal === null ||
    baseline.tokensPerFinishedGoal <= 0
  ) {
    return null;
  }
  return 1 - result.tokensPerFinishedGoal / baseline.tokensPerFinishedGoal;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function headline(configs: readonly BaselineConfigResult[]): string {
  const single = configs.find((result) => result.id === SINGLE_AGENT_CONFIG.id);
  const company = configs.find((result) => result.id === COMPANY_CONFIG.id);
  if (single === undefined || company === undefined) {
    return "This run did not include both the plain single agent and the full company, so there is no headline comparison.";
  }
  if (company.tokensPerFinishedGoal === null) {
    return "Generic Corp finished no goals in this run, so its tokens per finished goal cannot be measured.";
  }
  if (single.tokensPerFinishedGoal === null) {
    return "The plain single agent finished no goals in this run, so there is nothing to compare Generic Corp's tokens against.";
  }
  const cut = company.reductionVsSingleAgent ?? 0;
  const claim = `NOVA claims ${percent(NOVA_CLAIMED_REDUCTION)}`;
  return cut >= 0
    ? `Generic Corp used ${percent(cut)} fewer tokens per finished goal than a plain single agent (${claim}).`
    : `Generic Corp used ${percent(-cut)} more tokens per finished goal than a plain single agent (${claim}).`;
}

function tokens(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(Math.round(value));
}

/** The estimate as the owner sees it before confirming a run. */
export function describeBaselineEstimate(plan: BaselinePlan, estimate: BaselineEstimate): string {
  const source =
    estimate.basis === "measured"
      ? "from the last checkup's real usage"
      : "a guess until the first checkup has run";
  return [
    `The checkup runs ${plan.caseIds.join(", ")} from the ${plan.templateId} template, ${plan.trials} attempt(s) each, on ${plan.configs.length} configuration(s): ${plan.configs.map((config) => config.label).join("; ")}.`,
    `Expected usage: ${tokens(estimate.lowTokens)} to ${tokens(estimate.highTokens)} tokens, cache reads included (${source}). It stops at ${tokens(estimate.maxTokens)} tokens.`,
  ].join("\n");
}

export function renderBaselineMarkdown(report: BaselineReport): string {
  const rows = report.configs.map((result) => {
    const cut =
      result.reductionVsSingleAgent === null
        ? result.id === SINGLE_AGENT_CONFIG.id
          ? "baseline"
          : "n/a"
        : percent(result.reductionVsSingleAgent);
    return `| ${result.label} | ${result.passed}/${result.attempts} | ${tokens(result.totalTokens)} | ${tokens(result.tokensPerFinishedGoal)} | ${cut} |`;
  });
  return [
    "# Baseline comparison",
    "",
    report.headline,
    "",
    `Goals: ${report.caseIds.join(", ")} (${report.templateId}), ${report.trials} attempt(s) per configuration. Generated ${report.generatedAt}.`,
    "",
    "| Configuration | Finished | Tokens | Tokens per finished goal | Cut vs single agent |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Spent ${tokens(report.spent.tokens)} tokens over ${report.spent.responses} model responses${
      report.maxTokens === undefined ? "." : ` (cap ${tokens(report.maxTokens)}).`
    }`,
    ...(report.capReason === undefined
      ? []
      : ["", `${report.capReason} Attempts not run count as unfinished.`]),
    ...report.configs.flatMap((result) => [
      "",
      `<details><summary>${result.label}</summary>`,
      "",
      renderGoalEvalMarkdown(result.report),
      "",
      "</details>",
    ]),
    "",
  ].join("\n");
}
