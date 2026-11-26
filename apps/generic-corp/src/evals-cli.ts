import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { missingProviderKeys, runTemplateEvals, type TemplateEvalMode } from "./evals.js";
import { ORG_TIERS, type OrgTier } from "./company.js";
import { createSpendCap } from "./spend.js";
import { listCompanyTemplates, loadCompanyTemplate } from "./templates.js";

/** Live runs never go uncapped: these apply when no cap is given. */
export const DEFAULT_LIVE_MAX_USD = 50;
export const DEFAULT_LIVE_MAX_TOKENS = 40_000_000;

/**
 * `--economy`: the cheapest models that still exercise the whole cascade, for calibration runs.
 * The judge keeps each template's own VP model, so grading stays as strict as a full run.
 */
export const ECONOMY_MODELS: Readonly<Record<OrgTier, string>> = Object.freeze({
  ceo: "anthropic/claude-sonnet-5-5",
  vp: "anthropic/claude-haiku-5-5",
  ic: "anthropic/claude-haiku-5-5",
});

/** Exit code of a live run that could not start because a provider key is missing. */
export const EXIT_MISSING_KEY = 3;

/** Exit code of a live run refused because it is running in GitHub Actions. */
export const EXIT_LIVE_IN_CI = 4;

const USAGE = `Usage: npm run evals -w @generic-ai/app-generic-corp -- [options]

Runs company template goal evals and exits 1 when any gate fails.

  --template <id>   A template to evaluate (repeatable). Default: every template.
  --live            Run on the templates' real models with a model judge (needs provider keys).
                    Default: replay the recorded turns offline.
  --trials <n>      Attempts per case. Default: 1 for replays, the suite's count for live runs.
  --economy         Live: run the CEO on Sonnet 5.5 and VPs and ICs on Haiku 5.5 instead of the
                    templates' models. The judge keeps each template's VP model.
  --model <t>=<ref> Live: run org tier t (ceo, vp or ic) on model ref, for example
                    vp=anthropic/claude-haiku-5-5 (repeatable, applied after --economy).
  --max-usd <n>     Live: stop once the whole run has spent this many dollars, judge included.
                    Default: ${DEFAULT_LIVE_MAX_USD}.
  --max-tokens <n>  Live: stop once the whole run has used this many tokens (cache reads count).
                    Default: ${DEFAULT_LIVE_MAX_TOKENS}.
  --out <dir>       Write each report as <template>.md and <template>.json in this folder, and
                    the run's verdict and spend as summary.json.
  --help            Show this message.

A live run whose provider key is missing exits ${EXIT_MISSING_KEY} before spending anything, and one
started in GitHub Actions exits ${EXIT_LIVE_IN_CI}: live runs are manual only. Once a cap is
reached, the turn in flight stops, and attempts not yet started are skipped and count as failures.

Templates: ${listCompanyTemplates().join(", ")}`;

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      template: { type: "string", multiple: true },
      live: { type: "boolean", default: false },
      trials: { type: "string" },
      out: { type: "string" },
      "max-usd": { type: "string" },
      "max-tokens": { type: "string" },
      economy: { type: "boolean", default: false },
      model: { type: "string", multiple: true },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const mode: TemplateEvalMode = values.live ? "live" : "replay";
  const trials =
    values.trials === undefined ? (mode === "replay" ? 1 : undefined) : Number(values.trials);
  if (trials !== undefined && (!Number.isInteger(trials) || trials < 1)) {
    console.error("--trials must be a whole number of at least 1.");
    return 2;
  }
  const maxUsd = positive(values["max-usd"], mode === "live" ? DEFAULT_LIVE_MAX_USD : undefined);
  const maxTokens = positive(
    values["max-tokens"],
    mode === "live" ? DEFAULT_LIVE_MAX_TOKENS : undefined,
  );
  if (Number.isNaN(maxUsd) || Number.isNaN(maxTokens)) {
    console.error("--max-usd and --max-tokens must be positive numbers.");
    return 2;
  }
  const models = modelOverrides(values.economy, values.model ?? []);
  if (typeof models === "string") {
    console.error(models);
    return 2;
  }
  const templates = values.template ?? listCompanyTemplates();
  if (mode === "live") {
    const missing = new Map<string, readonly string[]>();
    for (const templateId of templates) {
      const company = await loadCompanyTemplate(templateId);
      for (const { provider, variables } of missingProviderKeys({
        ...company,
        models: { ...company.models, ...models },
      })) {
        missing.set(provider, variables);
      }
    }
    if (missing.size > 0) {
      console.error(
        `Live evals need a key for ${[...missing]
          .map(([provider, variables]) => `${provider} (${variables.join(" or ")})`)
          .join(", ")}. Nothing was run and nothing was spent.`,
      );
      return EXIT_MISSING_KEY;
    }
    // Automated runs never call a real model: live evals are started by hand only.
    if (process.env["GITHUB_ACTIONS"] === "true") {
      console.error(
        "Live evals call real models and only run by hand, never in GitHub Actions. Nothing was run.",
      );
      return EXIT_LIVE_IN_CI;
    }
    if (!process.env["BRAVE_API_KEY"] && !process.env["TAVILY_API_KEY"]) {
      console.warn(
        "No BRAVE_API_KEY or TAVILY_API_KEY is set, so web_search is off: goals that require a search will fail their research check.",
      );
    }
  }
  const spendCap = createSpendCap({
    ...(maxUsd === undefined ? {} : { maxCostUsd: maxUsd }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  if (values.out !== undefined) {
    await mkdir(values.out, { recursive: true });
  }
  let failed = 0;
  let notRun = 0;
  const verdicts: Array<{ template: string; passed: boolean; notRun: number }> = [];
  for (const templateId of templates) {
    const run = await runTemplateEvals({
      templateId,
      mode,
      spendCap,
      ...(trials === undefined ? {} : { trials }),
      ...(mode === "live" && Object.keys(models).length > 0 ? { models } : {}),
    });
    notRun += run.notRun;
    verdicts.push({ template: templateId, passed: run.report.gate.passed, notRun: run.notRun });
    console.log(run.markdown);
    if (values.out !== undefined) {
      await writeFile(path.join(values.out, `${templateId}.md`), run.markdown);
      await writeFile(
        path.join(values.out, `${templateId}.json`),
        `${JSON.stringify(run.report, null, 2)}\n`,
      );
    }
    if (!run.report.gate.passed) {
      failed += 1;
    }
  }
  const spent = spendCap.spent();
  const capReason = spendCap.reason();
  const caps = [
    ...(maxUsd === undefined ? [] : [`$${maxUsd}`]),
    ...(maxTokens === undefined ? [] : [`${maxTokens} tokens`]),
  ];
  console.log(
    [
      failed === 0
        ? `All ${templates.length} template eval suites passed (${mode}).`
        : `${failed} of ${templates.length} template eval suites failed (${mode}).`,
      `Spent ${spent.totalTokens} tokens and $${spent.costUsd.toFixed(2)} over ${spent.responses} model responses${
        caps.length === 0 ? "." : ` (caps: ${caps.join(", ")}).`
      }`,
      ...(capReason === undefined
        ? []
        : [`${capReason} ${notRun} attempt(s) were not run and count as failures.`]),
    ].join("\n"),
  );
  if (values.out !== undefined) {
    await writeFile(
      path.join(values.out, "summary.json"),
      `${JSON.stringify(
        {
          mode,
          passed: failed === 0,
          ...(mode === "live" && Object.keys(models).length > 0 ? { models } : {}),
          templates: verdicts,
          spent: { tokens: spent.totalTokens, costUsd: spent.costUsd, responses: spent.responses },
          caps: {
            ...(maxUsd === undefined ? {} : { maxCostUsd: maxUsd }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
          },
          capReached: capReason !== undefined,
          notRun,
        },
        null,
        2,
      )}\n`,
    );
  }
  return failed === 0 ? 0 : 1;
}

/** Tier model overrides from `--economy` and `--model tier=ref`, or an error message. */
export function modelOverrides(
  economy: boolean,
  flags: readonly string[],
): Partial<Record<OrgTier, string>> | string {
  const models: Partial<Record<OrgTier, string>> = economy ? { ...ECONOMY_MODELS } : {};
  for (const flag of flags) {
    const separator = flag.indexOf("=");
    const tier = flag.slice(0, Math.max(separator, 0)).trim();
    const ref = flag.slice(separator + 1).trim();
    if (separator < 1 || !(ORG_TIERS as readonly string[]).includes(tier) || !ref.includes("/")) {
      return `--model must look like vp=anthropic/claude-haiku-5-5 (tiers: ${ORG_TIERS.join(", ")}); got "${flag}".`;
    }
    models[tier as OrgTier] = ref;
  }
  return models;
}

/** A positive number from a flag; the fallback when absent; NaN when invalid. */
function positive(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
