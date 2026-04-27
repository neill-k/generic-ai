#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderBenchmarkReportMarkdown, type BenchmarkReport } from "@generic-ai/sdk";

export interface RenderBenchmarkReportOptions {
  readonly inputPath: string;
  readonly outputPath?: string;
}

export async function renderBenchmarkReportFile(
  options: RenderBenchmarkReportOptions,
): Promise<string> {
  const report = JSON.parse(await readFile(options.inputPath, "utf-8")) as BenchmarkReport;
  const markdown = renderBenchmarkReportMarkdown(report);
  if (options.outputPath !== undefined) {
    await writeFile(options.outputPath, markdown, "utf-8");
  }

  return markdown;
}

function parseArgs(argv: readonly string[]): RenderBenchmarkReportOptions {
  const options: {
    inputPath?: string;
    outputPath?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(
          "Usage: generic-ai-render-benchmark-report --input <path> [--output <path>]",
        );
        process.exit(0);
        break;
      case "--input":
        if (next === undefined) {
          throw new Error("--input requires a value.");
        }
        options.inputPath = next;
        index += 1;
        break;
      case "--output":
        if (next === undefined) {
          throw new Error("--output requires a value.");
        }
        options.outputPath = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.inputPath === undefined) {
    throw new Error("Provide --input.");
  }

  return {
    inputPath: options.inputPath,
    ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
  };
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  renderBenchmarkReportFile(parseArgs(process.argv.slice(2)))
    .then((markdown) => {
      if (process.argv.includes("--output")) {
        return;
      }
      process.stdout.write(markdown);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
