#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmarkProfile } from "./benchmark-profile.js";

interface BenchmarkAgentCliOptions {
  readonly instruction?: string;
  readonly instructionFile?: string;
  readonly outputDir?: string;
  readonly workspaceRoot?: string;
}

function usage(): string {
  return [
    "Usage: generic-ai-terminal-bench-agent --instruction-file <path> [options]",
    "",
    "Options:",
    "  --instruction <text>       Inline task instruction.",
    "  --instruction-file <path>  Path to a markdown instruction file.",
    "  --output-dir <path>        Artifact output directory. Defaults to /logs/artifacts/generic-ai.",
    "  --workspace <path>         Task workspace root. Defaults to cwd.",
    "  --help                     Show this help.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): BenchmarkAgentCliOptions {
  const options: {
    instruction?: string;
    instructionFile?: string;
    outputDir?: string;
    workspaceRoot?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--instruction":
        if (next === undefined) {
          throw new Error("--instruction requires a value.");
        }
        options.instruction = next;
        index += 1;
        break;
      case "--instruction-file":
        if (next === undefined) {
          throw new Error("--instruction-file requires a value.");
        }
        options.instructionFile = next;
        index += 1;
        break;
      case "--output-dir":
        if (next === undefined) {
          throw new Error("--output-dir requires a value.");
        }
        options.outputDir = next;
        index += 1;
        break;
      case "--workspace":
        if (next === undefined) {
          throw new Error("--workspace requires a value.");
        }
        options.workspaceRoot = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function loadInstruction(options: BenchmarkAgentCliOptions): Promise<string> {
  if (options.instruction !== undefined) {
    return options.instruction;
  }

  if (options.instructionFile !== undefined) {
    return readFile(options.instructionFile, "utf-8");
  }

  throw new Error("Provide --instruction or --instruction-file.");
}

export async function runBenchmarkAgentCli(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const instruction = await loadInstruction(options);
  const result = await runBenchmarkProfile({
    instruction,
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  });

  console.log(
    JSON.stringify(
      {
        runId: result.summary.runId,
        status: result.summary.status,
        artifactDir: result.summary.artifactDir,
      },
      null,
      2,
    ),
  );

  return result.summary.status === "passed" ? 0 : 1;
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  runBenchmarkAgentCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
