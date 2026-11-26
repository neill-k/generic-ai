import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { missingProviderKeys, runTemplateEvals, type TemplateEvalMode } from "./evals.js";
import { createSpendCap } from "./spend.js";
import { listCompanyTemplates, loadCompanyTemplate } from "./templates.js";

/** Live runs never go uncapped: these apply when no cap is given. */
export const DEFAULT_LIVE_MAX_USD = 50;
export const DEFAULT_LIVE_MAX_TOKENS = 40_000_000;

/** Exit code of a live run that could not start because a provider key is missing. */
export const EXIT_MISSING_KEY = 3;

const USAGE = `Usage: npm run evals -w @generic-ai/app-generic-corp -- [options]

Runs company template goal evals and exits 1 when any gate fails.

  --template <id>   A template to evaluate (repeatable). Default: every template.
  --live            Run on the templates' real models with a model judge (needs provider keys).
                    Default: replay the recorded turns offline.
  --trials <n>      Attempts per case. Default: 1 for replays, the suite's count for live runs.
  --max-usd <n>     Live: stop once the whole run has spent this many dollars, judge included.
                    Default: ${DEFAULT_LIVE_MAX_USD}.
  --max-tokens <n>  Live: stop once the whole run has used this many tokens (cache reads count).
                    Default: ${DEFAULT_LIVE_MAX_TOKENS}.
  --out <dir>       Write each report as <template>.md and <template>.json in this folder, and
                    the run's verdict and spend as summary.json.
  --help            Show this message.

A live run whose provider key is missing exits ${EXIT_MISSING_KEY} before spending anything. Once a cap is
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
  const templates = values.template ?? listCompanyTemplates();
  if (mode === "live") {
    const missing = new Map<string, readonly string[]>();
    for (const templateId of templates) {
      for (const { provider, variables } of missingProviderKeys(
        await loadCompanyTemplate(templateId),
      )) {
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
