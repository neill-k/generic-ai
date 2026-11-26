import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runTemplateEvals, type TemplateEvalMode } from "./evals.js";
import { listCompanyTemplates } from "./templates.js";

const USAGE = `Usage: npm run evals -w @generic-ai/app-generic-corp -- [options]

Runs company template goal evals and exits 1 when any gate fails.

  --template <id>   A template to evaluate (repeatable). Default: every template.
  --live            Run on the templates' real models with a model judge (needs provider keys).
                    Default: replay the recorded turns offline.
  --trials <n>      Attempts per case. Default: 1 for replays, the suite's count for live runs.
  --out <dir>       Write each report as <template>.md and <template>.json in this folder.
  --help            Show this message.

Templates: ${listCompanyTemplates().join(", ")}`;

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      template: { type: "string", multiple: true },
      live: { type: "boolean", default: false },
      trials: { type: "string" },
      out: { type: "string" },
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
  const templates = values.template ?? listCompanyTemplates();
  let failed = 0;
  for (const templateId of templates) {
    const run = await runTemplateEvals({
      templateId,
      mode,
      ...(trials === undefined ? {} : { trials }),
    });
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
  console.log(
    failed === 0
      ? `All ${templates.length} template eval suites passed (${mode}).`
      : `${failed} of ${templates.length} template eval suites failed (${mode}).`,
  );
  return failed === 0 ? 0 : 1;
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
