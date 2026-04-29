import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderBenchmarkReportMarkdown, type BenchmarkSpec, type HarnessDsl, type MissionSpec } from "@generic-ai/sdk";
import { runHarnessBenchmark, type HarnessBenchmarkRuntimeContext } from "@generic-ai/core";
import type { GenericAILlmRuntime, GenericAILlmRunResult, GenericAILlmStreamChunk } from "@generic-ai/core";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_PATHS = [
  resolve(EXAMPLE_ROOT, "candidates", "direct-function-caller.json"),
  resolve(EXAMPLE_ROOT, "candidates", "retrieval-grounded-tool-caller.json"),
] as const;

export interface ToolCallingFixture {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly harnesses: Readonly<Record<string, HarnessDsl>>;
}

export interface ToolCallingSmokeResult {
  readonly fixture: ToolCallingFixture;
  readonly markdown: string;
  readonly report: Awaited<ReturnType<typeof runHarnessBenchmark>>["report"];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

export async function loadToolCallingFixture(): Promise<ToolCallingFixture> {
  const [benchmark, mission, ...harnessList] = await Promise.all([
    readJson<BenchmarkSpec>(resolve(EXAMPLE_ROOT, "benchmark.json")),
    readJson<MissionSpec>(resolve(EXAMPLE_ROOT, "mission.json")),
    ...CANDIDATE_PATHS.map((path) => readJson<HarnessDsl>(path)),
  ]);
  const harnesses = Object.fromEntries(harnessList.map((harness) => [harness.id, harness]));

  return Object.freeze({
    benchmark,
    mission,
    harnesses: Object.freeze(harnesses),
  });
}

function createResult(context: HarnessBenchmarkRuntimeContext, outputText: string): GenericAILlmRunResult {
  return Object.freeze({
    adapter: "openai-codex",
    model: "deterministic-micro-adapter",
    outputText: [
      `Candidate ${context.candidateId}`,
      `Trial ${context.trialId}`,
      outputText,
    ].join("\n"),
  });
}

function deterministicOutput(context: HarnessBenchmarkRuntimeContext): string {
  if (context.candidateId === "retrieval-grounded-tool-caller") {
    return [
      "TOOL_CALL_OK function=answer_from_policy_chunk",
      "RETRIEVAL_CHUNK:benefits-pto-2026",
      "ANSWER: 15 days",
      "Artifacts: tool-call-trace.json grounded-answer.md",
    ].join("\n");
  }

  return [
    "TOOL_CALL_MISGROUNDED function=lookup_policy_limit",
    "ANSWER: 10 days",
    "Artifacts: tool-call-trace.json",
  ].join("\n");
}

export async function createDeterministicToolCallingRuntime(
  context: HarnessBenchmarkRuntimeContext,
): Promise<GenericAILlmRuntime> {
  const run = async (): Promise<GenericAILlmRunResult> =>
    createResult(context, deterministicOutput(context));

  return Object.freeze({
    adapter: "openai-codex",
    model: "deterministic-micro-adapter",
    ...(context.compiled.agents[0]?.instructions === undefined
      ? {}
      : { instructions: context.compiled.agents[0].instructions }),
    run,
    stream: async function* stream(): AsyncIterable<GenericAILlmStreamChunk> {
      const response = await run();
      yield { type: "text-delta", delta: response.outputText };
      yield { type: "response", response };
    },
  });
}

export async function runToolCallingSmoke(): Promise<ToolCallingSmokeResult> {
  const fixture = await loadToolCallingFixture();
  const result = await runHarnessBenchmark({
    ...fixture,
    createRuntime: createDeterministicToolCallingRuntime,
    now: () => "2026-04-29T00:00:00.000Z",
  });

  return Object.freeze({
    fixture,
    markdown: renderBenchmarkReportMarkdown(result.report),
    report: result.report,
  });
}
