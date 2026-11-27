import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  PROVIDER_API_KEY_ENV,
  parseModelRef,
  registerFauxProvider,
} from "@generic-ai/ai";
import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import type { WebSearchResult } from "@generic-ai/plugin-tools-web";
import {
  type GoalEvalExecution,
  type GoalEvalExecutor,
  type GoalEvalReport,
  type GoalJudge,
  type GoalJudgment,
  type JsonObject,
  renderGoalEvalMarkdown,
  runGoalEvalSuite,
} from "@generic-ai/sdk";
import { parse as parseYaml } from "yaml";

import {
  type CompanyConfig,
  CompanyConfigError,
  ceoOf,
  companyAgentSeeds,
  companyGoal,
  DEFAULT_TIER_MODELS,
  modelFor,
  type OrgTier,
} from "./company.js";
import { companyLayout } from "./drive.js";
import type { EgressProxy } from "./egress.js";
import { collectCompanyGoalEvidence, createModelJudge } from "./goals.js";
import type { CompanyModelAuth } from "./model-auth.js";
import { secondOpinionModel } from "./second-opinion.js";
import { createGenericCorpServer } from "./server.js";
import type { SpendCap } from "./spend.js";
import { loadTemplateEvalSuite, type TemplateEvalSuite } from "./templates.js";
import { createCompanyToolkit } from "./toolkit.js";

/**
 * Goal evals for company templates (roadmap R15 and R26). Every attempt starts a fresh company
 * from the template, sends the goal's request to the CEO with the goal attached, lets the whole
 * org chart work through the durable cascade, and scores the result from the team's trace with
 * `@generic-ai/sdk`'s goal evals: numeric outcomes, rubric grades, required actions, held-out
 * checks, integrity, and tokens per completed goal.
 *
 * Two modes:
 *
 * - `replay` runs each case from its recorded agent turns (`replays/<case>.yaml`) on a scripted
 *   model, with recorded search results, pages and rubric judgments. No network and no key, so
 *   it runs in CI on every change and fails the build when a template, a goal, a validator, a
 *   tool or the cascade breaks.
 * - `live` runs the same cases on the template's real models with a model judge. This is what
 *   the reliability gate (R19) runs once provider keys are available in CI.
 */
export type TemplateEvalMode = "replay" | "live";

/** One model response in a replay: a single tool call. */
export interface ReplayStep {
  readonly call: string;
  readonly args?: JsonObject;
}

export interface TemplateReplay {
  /** Results `web_search` returns, whatever the query. */
  readonly search?: readonly WebSearchResult[];
  /** Pages `web_fetch` returns, by URL. Other URLs are 404. */
  readonly pages?: Readonly<Record<string, string>>;
  /** Recorded rubric judgments, by validator id. */
  readonly judgments?: Readonly<Record<string, GoalJudgment>>;
  /** Each agent's turns, in order. Every step is one model response with one tool call. */
  readonly agents: Readonly<Record<string, readonly ReplayStep[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadTemplateReplay(file: string): Promise<TemplateReplay> {
  const raw = parseYaml(await readFile(file, "utf8")) as unknown;
  if (!isRecord(raw) || !isRecord(raw["agents"])) {
    throw new CompanyConfigError(`Replay ${file} must map agents to their steps.`);
  }
  for (const [agentId, steps] of Object.entries(raw["agents"])) {
    if (
      !Array.isArray(steps) ||
      steps.some((step) => !isRecord(step) || typeof step["call"] !== "string")
    ) {
      throw new CompanyConfigError(
        `Replay ${file}: agents.${agentId} must be a list of { call, args }.`,
      );
    }
  }
  return raw as unknown as TemplateReplay;
}

const AGENT_IN_TASK = /\(agent id "([A-Za-z0-9._-]+)", role /;

/** The agent a model request is for, read from the task prompt the cascade wrote for it. */
function agentOf(context: Context): string | undefined {
  const first = context.messages[0];
  if (first === undefined || first.role !== "user") {
    return undefined;
  }
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return AGENT_IN_TASK.exec(text)?.[1];
}

interface ReplayModel {
  readonly resolveModel: (ref: string) => Model;
  /** Agents with steps left over: the run took a different path than recorded. */
  leftovers(): readonly string[];
  /** Requests no recorded step could answer. */
  readonly unexpected: string[];
  unregister(): void;
}

function createReplayModel(replay: TemplateReplay): ReplayModel {
  const queues = new Map<string, ReplayStep[]>(
    Object.entries(replay.agents).map(([agentId, steps]) => [agentId, [...steps]]),
  );
  const unexpected: string[] = [];
  const provider = registerFauxProvider({ models: [{ id: "replay" }] });
  const respond = (context: Context) => {
    const agentId = agentOf(context) ?? "unknown";
    const step = queues.get(agentId)?.shift();
    if (step === undefined) {
      unexpected.push(agentId);
      return fauxAssistantMessage(
        [
          fauxToolCall("stop_and_respond", {
            response: `The replay has no more turns for ${agentId}.`,
            status: "failed",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxToolCall(step.call, step.args ?? {})], {
      stopReason: "toolUse",
    });
  };
  // Enough responders for any replay; each one reads the next recorded step for its agent.
  const total = [...queues.values()].reduce((sum, steps) => sum + steps.length, 0);
  provider.setResponses(Array.from({ length: total + 16 }, () => respond));
  const model = provider.getModel("replay");
  if (model === undefined) {
    throw new Error("The replay model could not be registered.");
  }
  return {
    resolveModel: () => model,
    leftovers: () =>
      [...queues.entries()].filter(([, steps]) => steps.length > 0).map(([agentId]) => agentId),
    unexpected,
    unregister: () => provider.unregister(),
  };
}

function replayJudge(replay: TemplateReplay): GoalJudge {
  return (request) => {
    const judgment = replay.judgments?.[request.validatorId];
    if (judgment === undefined) {
      throw new Error(`The replay has no recorded judgment for ${request.validatorId}.`);
    }
    return judgment;
  };
}

const FIXTURE_ADDRESS = [{ address: "93.184.216.34", family: 4 as const }];

export interface CompanyEvalExecutorOptions {
  readonly company: CompanyConfig;
  readonly mode: TemplateEvalMode;
  /** Replay files by case id. Required in replay mode. */
  readonly replays?: Readonly<Record<string, string>>;
  /** Live mode: the environment for keys and secrets. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Live mode: replaces the model resolver, for example to pin every agent to one model. */
  readonly resolveModel?: (ref: string) => Model;
  /** Live mode: replaces the model judge. */
  readonly judge?: GoalJudge;
  /**
   * Live mode: an egress proxy to share, when the attempts run inside a server whose agent
   * firewall only allows that server's proxy port.
   */
  readonly egressProxy?: Pick<EgressProxy, "envFor">;
  /** Live mode: where agents get their model credential, for example the owner's Claude sign-in. */
  readonly modelAuth?: CompanyModelAuth;
  /**
   * Feature switches for the baseline comparison: `offload: false` keeps large tool results in
   * context, `rlm: false` leaves out the Python workspace, `memory: false` gives agents no memory
   * (no handbook or memory section, no remember and forget tools). Everything is on by default.
   */
  readonly features?: {
    readonly offload?: boolean;
    readonly rlm?: boolean;
    readonly memory?: boolean;
  };
  /**
   * A token and dollar cap over every attempt. Each agent turn starts with what is left as its
   * harness budget, and attempts that would start after the cap is reached are not run.
   */
  readonly spendCap?: SpendCap;
  /** Called for each attempt skipped because the spend cap was reached. */
  readonly onSkipped?: (caseId: string) => void;
  readonly log?: (message: string) => void;
}

/** The failure message of an attempt that never started because the spend cap was reached. */
export const NOT_RUN_PREFIX = "Not run:" as const;

/**
 * Runs one eval attempt in a fresh company: new data directory, new agents, no shared state
 * between attempts, so pass^k means what it says.
 */
export function createCompanyEvalExecutor(options: CompanyEvalExecutorOptions): GoalEvalExecutor {
  const log = options.log ?? (() => undefined);
  return async (attempt): Promise<GoalEvalExecution> => {
    const caseId = attempt.caseSpec.id;
    const goalTemplate = companyGoal(options.company, attempt.sealed.goal.spec.id);
    const request = [
      goalTemplate?.request ?? attempt.sealed.goal.spec.objective,
      attempt.caseSpec.instruction,
    ]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join("\n\n");

    const capped = options.spendCap?.reason();
    if (capped !== undefined) {
      options.onSkipped?.(caseId);
      return { runStatus: "cancelled", failureMessage: `${NOT_RUN_PREFIX} ${capped}`, events: [] };
    }

    let replay: TemplateReplay | undefined;
    let model: ReplayModel | undefined;
    if (options.mode === "replay") {
      const file = options.replays?.[caseId];
      if (file === undefined) {
        throw new Error(`Case ${caseId} has no replay file.`);
      }
      replay = await loadTemplateReplay(file);
      model = createReplayModel(replay);
    }
    const dataDir = mkdtempSync(path.join(tmpdir(), `generic-corp-eval-${caseId}-`));
    const started = Date.now();
    try {
      const pages = replay?.pages ?? {};
      const toolkit =
        replay === undefined
          ? undefined
          : createCompanyToolkit({
              company: options.company,
              env: {},
              searchProvider: {
                name: "replay",
                search: async ({ limit }) => (replay?.search ?? []).slice(0, limit),
              },
              resolver: async () => FIXTURE_ADDRESS,
              fetcher: async (input) => {
                const url = input instanceof Request ? input.url : String(input);
                const page = pages[url];
                return page === undefined
                  ? new Response("Not found", { status: 404 })
                  : new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
              },
            });
      const resolveModel = model?.resolveModel ?? options.resolveModel;
      const judge = replay === undefined ? options.judge : replayJudge(replay);
      const spendCap = options.spendCap;
      const native = {
        ...(resolveModel === undefined ? {} : { resolveModel }),
        ...(options.features?.offload === false ? { offload: false as const } : {}),
        ...(options.features?.rlm === false ? { rlm: false } : {}),
      };
      const executorOptions = {
        ...(Object.keys(native).length === 0 ? {} : { native }),
        ...(spendCap === undefined
          ? {}
          : {
              budget: () => spendCap.turnBudget(),
              onTurnUsage: (_input: unknown, totals: Parameters<SpendCap["record"]>[0]) =>
                spendCap.record(totals),
            }),
      };
      const server = await createGenericCorpServer({
        environment: {
          host: "127.0.0.1",
          port: 0,
          dataDir,
          trustProxyHeaders: false,
          insecureNoAuth: true,
          workers: false,
        },
        env: replay === undefined ? (options.env ?? process.env) : {},
        company: options.company,
        ...(toolkit === undefined ? {} : { toolkit }),
        ...(Object.keys(executorOptions).length === 0 ? {} : { executorOptions }),
        ...(judge === undefined ? {} : { goals: { judges: judge } }),
        ...(options.modelAuth === undefined || replay !== undefined
          ? {}
          : { modelAuth: options.modelAuth }),
        ...(options.features?.memory === false ? { agentMemory: false } : {}),
        checkup: false,
        ...(options.egressProxy === undefined || replay !== undefined
          ? {}
          : { egressProxy: options.egressProxy }),
        authStore: createMemoryAuthStore(),
        log,
      });
      try {
        const { task } = await server.runtime.sendMessage({
          text: request,
          goal: { spec: attempt.sealed.goal.spec },
        });
        await server.runtime.cascade.drain();
        const settled = (await server.runtime.cascade.get(task.taskId)) ?? task;
        const outputText = settled.outputText ?? "";
        const evidence = await collectCompanyGoalEvidence(
          {
            runStore: server.storage.runStore,
            cascade: () => server.runtime.cascade,
            directory: () => server.runtime.directory,
            companyRoot: companyLayout(dataDir).root,
          },
          {
            rootTaskId: task.taskId,
            ...(settled.handIn === undefined ? {} : { handIn: settled.handIn }),
            agentId: settled.agentId,
          },
        );
        const problems = [
          ...(model?.unexpected.length
            ? [`unrecorded turns for ${[...new Set(model.unexpected)].join(", ")}`]
            : []),
          ...(model?.leftovers().length
            ? [`unused recorded turns for ${model.leftovers().join(", ")}`]
            : []),
        ];
        const runStatus =
          settled.status === "succeeded"
            ? "succeeded"
            : settled.status === "cancelled"
              ? "cancelled"
              : settled.status === "waiting"
                ? "blocked"
                : "failed";
        const failure =
          settled.failureMessage ??
          (settled.status === "succeeded" ? undefined : `The CEO's task ended ${settled.status}.`);
        const failureMessage = [
          failure,
          ...(problems.length > 0 ? [`Replay drift: ${problems.join("; ")}.`] : []),
        ]
          .filter((part): part is string => part !== undefined)
          .join(" ");
        return {
          runId: task.taskId,
          runStatus: problems.length > 0 && runStatus === "succeeded" ? "failed" : runStatus,
          ...(failureMessage.length > 0 ? { failureMessage } : {}),
          outputText,
          ...(evidence.output === undefined ? {} : { output: evidence.output }),
          ...(evidence.artifacts === undefined ? {} : { artifacts: evidence.artifacts }),
          ...(evidence.metrics === undefined ? {} : { metrics: evidence.metrics }),
          events: evidence.events,
          durationMs: Date.now() - started,
        };
      } finally {
        await server.stop();
      }
    } finally {
      model?.unregister();
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

export interface RunTemplateEvalsOptions {
  readonly templateId: string;
  readonly mode: TemplateEvalMode;
  /** Overrides the suite's trial count, for example 1 for a quick replay. */
  readonly trials?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveModel?: (ref: string) => Model;
  /**
   * Live mode: replaces the template's model for an org tier, for example a cheaper model for a
   * calibration run. The judge keeps the template's own VP model, so grading does not get weaker.
   */
  readonly models?: Partial<Readonly<Record<OrgTier, string>>>;
  readonly judge?: GoalJudge;
  /** Token and dollar cap over the whole run, judge calls included. Share one across templates. */
  readonly spendCap?: SpendCap;
  readonly log?: (message: string) => void;
}

export interface TemplateEvalRun {
  readonly template: TemplateEvalSuite;
  readonly report: GoalEvalReport;
  readonly markdown: string;
  /** Attempts not started because the spend cap was reached. They count as failed trials. */
  readonly notRun: number;
}

/**
 * Wraps a judge so it refuses to grade once the cap is reached. A refused grade is an error,
 * which fails the validator rather than passing it.
 */
export function cappedJudge(judge: GoalJudge, spendCap: SpendCap | undefined): GoalJudge {
  if (spendCap === undefined) {
    return judge;
  }
  return (request) => {
    const reason = spendCap.reason();
    if (reason !== undefined) {
      throw new Error(reason);
    }
    return judge(request);
  };
}

/**
 * Environment variables a live run of the company needs: for each provider its models use, the
 * provider's key variables, none of which is set. Empty when every provider has a key.
 */
export function missingProviderKeys(
  company: CompanyConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly { readonly provider: string; readonly variables: readonly string[] }[] {
  const refs = new Set<string>([
    ...companyAgentSeeds(company).flatMap((seed) => (seed.model === undefined ? [] : [seed.model])),
    company.models?.vp ?? DEFAULT_TIER_MODELS.vp,
  ]);
  const providers = new Set([...refs].map((ref) => parseModelRef(ref).provider));
  return [...providers]
    .sort()
    .map((provider) => ({
      provider,
      variables: PROVIDER_API_KEY_ENV[provider] ?? [
        `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
      ],
    }))
    .filter(({ variables }) => !variables.some((name) => (env[name] ?? "").length > 0));
}

/** Runs a template's goal eval suite and returns the report; `report.gate.passed` is the verdict. */
export async function runTemplateEvals(options: RunTemplateEvalsOptions): Promise<TemplateEvalRun> {
  const loaded = await loadTemplateEvalSuite(options.templateId);
  // The company's goal is the CEO's, so the judge runs on a model other than the CEO's
  // (decision 12), from the template's own models, so overriding tiers does not weaken grading.
  const judgeModel = secondOpinionModel(
    loaded.company,
    modelFor(loaded.company, ceoOf(loaded.company).id),
  );
  const template =
    options.models === undefined || Object.keys(options.models).length === 0
      ? loaded
      : {
          ...loaded,
          company: { ...loaded.company, models: { ...loaded.company.models, ...options.models } },
        };
  const suite =
    options.trials === undefined
      ? template.suite
      : {
          ...template.suite,
          trials: { ...template.suite.trials, count: options.trials },
          cases: template.suite.cases.map(({ trials: _trials, ...rest }) => rest),
        };
  // Live runs grade with one judge, the same the company would use, metered against the cap.
  const judge =
    options.mode === "replay"
      ? undefined
      : cappedJudge(
          options.judge ??
            createModelJudge({
              model: judgeModel,
              ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
              ...(options.spendCap === undefined
                ? {}
                : { onUsage: (usage) => options.spendCap?.recordModelUsage(usage) }),
            }),
          options.spendCap,
        );
  let notRun = 0;
  const report = await runGoalEvalSuite({
    suite,
    execute: createCompanyEvalExecutor({
      company: template.company,
      mode: options.mode,
      replays: template.replays,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
      ...(judge === undefined ? {} : { judge }),
      ...(options.spendCap === undefined ? {} : { spendCap: options.spendCap }),
      onSkipped: () => {
        notRun += 1;
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
    // The eval re-runs every validator on the evidence. Replays bring their own recorded
    // judgments; live runs grade with the same judge the company uses.
    judges: judge ?? replayJudgesFor(template),
  });
  return { template, report, markdown: renderGoalEvalMarkdown(report), notRun };
}

/** Judges the eval's own re-scoring uses in replay mode: each case's recorded judgments. */
function replayJudgesFor(template: TemplateEvalSuite): GoalJudge {
  const loaded = new Map<string, Promise<TemplateReplay>>();
  const load = (file: string) => {
    let pending = loaded.get(file);
    if (pending === undefined) {
      pending = loadTemplateReplay(file);
      loaded.set(file, pending);
    }
    return pending;
  };
  // Held-out validators run under the goal id plus ":holdout". The first case of that goal
  // whose replay recorded a judgment for the validator answers.
  return async (request) => {
    const goalId = request.goalId.replace(/:holdout$/, "");
    for (const testCase of template.suite.cases) {
      const file = template.replays[testCase.id];
      if (file === undefined || testCase.goal.id !== goalId) {
        continue;
      }
      const judgment = (await load(file)).judgments?.[request.validatorId];
      if (judgment !== undefined) {
        return judgment;
      }
    }
    throw new Error(`No recorded judgment for ${request.goalId}/${request.validatorId}.`);
  };
}
