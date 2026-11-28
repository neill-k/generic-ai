import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  BASELINE_SETS,
  type BaselineSet,
  baselinePlan,
  describeBaselineEstimate,
  estimateBaseline,
  renderBaselineMarkdown,
  runBaseline,
} from "./baseline.js";
import { CLAUDE_PLAN_TOKEN_ENV, createClaudePlanCompletion } from "./claude-agent-sdk.js";
import { EXIT_LIVE_IN_CI, EXIT_MISSING_KEY } from "./evals-cli.js";
import { createCompanyModelAuth, resolveProviderKeyFromEnv } from "./model-auth.js";
import { createSpendCap } from "./spend.js";

const USAGE = `Usage: npm run checkup -w @generic-ai/app-generic-corp -- [options]

The checkup: runs the same goal through a plain single agent and through Generic Corp, on real
models, and reports tokens per finished goal for each. It shows the plan and the expected usage
first and starts only once you confirm.

  --set <name>       core (default): the single agent and the full company.
                     ablation: also the company with each feature off in turn (offloading,
                     the Python workspace, memory, delegation). About three times the usage.
  --trials <n>       Attempts per configuration. Default: 1.
  --max-tokens <n>   Stop once the run has used this many tokens. Default: the estimate's high end.
  --data-dir <dir>   The Generic Corp data folder whose saved API key to use. Default: GENERIC_CORP_DATA_DIR, else ~/.generic-corp.
                     ANTHROPIC_API_KEY in the environment is used when nothing is saved there.
  --out <dir>        Also write the report as baseline.md and baseline.json in this folder.
  --plan             Show the plan and the expected usage, then exit without running.
  --yes              Start without asking.
  --help             Show this message.

Exits 0 when the checkup ran (whatever it found), ${EXIT_MISSING_KEY} when agents have no model sign-in, ${EXIT_LIVE_IN_CI}
in GitHub Actions (live runs are started by hand only), and 2 on bad options or when not confirmed.`;

export async function main(
  argv: readonly string[],
  io: {
    readonly env?: NodeJS.ProcessEnv;
    readonly confirm?: (question: string) => Promise<boolean>;
  } = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      set: { type: "string" },
      trials: { type: "string" },
      "max-tokens": { type: "string" },
      "data-dir": { type: "string" },
      out: { type: "string" },
      plan: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const set = (values.set ?? "core") as BaselineSet;
  if (!Object.hasOwn(BASELINE_SETS, set)) {
    console.error(`--set is ${Object.keys(BASELINE_SETS).join(" or ")}.`);
    return 2;
  }
  const trials = values.trials === undefined ? undefined : Number(values.trials);
  if (trials !== undefined && (!Number.isInteger(trials) || trials < 1)) {
    console.error("--trials must be a whole number of at least 1.");
    return 2;
  }
  const maxTokensFlag =
    values["max-tokens"] === undefined ? undefined : Number(values["max-tokens"]);
  if (maxTokensFlag !== undefined && !(Number.isFinite(maxTokensFlag) && maxTokensFlag > 0)) {
    console.error("--max-tokens must be a positive number.");
    return 2;
  }

  const plan = baselinePlan({ set, ...(trials === undefined ? {} : { trials }) });
  const estimate = estimateBaseline(plan);
  const maxTokens = maxTokensFlag ?? estimate.maxTokens;
  console.log(describeBaselineEstimate(plan, { ...estimate, maxTokens }));
  if (values.plan) {
    return 0;
  }

  // Automated runs never call a real model: the checkup is started by hand only.
  if (env["GITHUB_ACTIONS"] === "true") {
    console.error("The checkup calls real models and only runs by hand, never in GitHub Actions.");
    return EXIT_LIVE_IN_CI;
  }
  const dataDir = path.resolve(
    values["data-dir"] ?? env["GENERIC_CORP_DATA_DIR"] ?? path.join(homedir(), ".generic-corp"),
  );
  const claudePlanToken = () => env[CLAUDE_PLAN_TOKEN_ENV]?.trim() || undefined;
  const modelAuth = createCompanyModelAuth({
    path: path.join(dataDir, "model-auth.json"),
    fallback: (provider) => resolveProviderKeyFromEnv(provider, env),
    claudePlanToken,
  });
  const auth = await modelAuth.status();
  if (auth.source === "none") {
    console.error(
      `No ${CLAUDE_PLAN_TOKEN_ENV} (from \`claude setup-token\`), no saved API key in ${dataDir} and no ANTHROPIC_API_KEY. Set one of them, or pass --data-dir. Nothing was run.`,
    );
    return EXIT_MISSING_KEY;
  }
  console.log(`Agents use ${describeSource(auth.source)}.`);

  if (!values.yes) {
    const confirm = io.confirm ?? (process.stdin.isTTY ? askYesNo : undefined);
    if (confirm === undefined) {
      console.error("Not started: pass --yes to start without a terminal to confirm in.");
      return 2;
    }
    if (!(await confirm("Start the checkup? [y/N] "))) {
      console.log("Not started.");
      return 2;
    }
  }

  const report = await runBaseline({
    plan,
    env,
    modelAuth,
    // Agent turns follow the environment (the plan when its token is set); so does the judge.
    complete: createClaudePlanCompletion({
      token: claudePlanToken,
      active: () => claudePlanToken() !== undefined,
      configDir: path.join(dataDir, "claude-agent-sdk"),
    }),
    spendCap: createSpendCap({ maxTokens }),
    log: (message) => console.error(message),
  });
  const markdown = renderBaselineMarkdown(report);
  console.log(markdown);
  if (values.out !== undefined) {
    await mkdir(values.out, { recursive: true });
    await writeFile(path.join(values.out, "baseline.md"), markdown);
    await writeFile(path.join(values.out, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return 0;
}

function describeSource(source: string): string {
  switch (source) {
    case "claude_plan":
      return `your Claude plan (${CLAUDE_PLAN_TOKEN_ENV}, through the Claude Agent SDK)`;
    case "api_key":
      return "the saved Anthropic API key";
    default:
      return "ANTHROPIC_API_KEY from the environment";
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
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
