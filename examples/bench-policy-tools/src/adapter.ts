import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runHarnessBenchmark, type HarnessBenchmarkRuntimeContext } from "@generic-ai/core";
import type { GenericAILlmRuntime, GenericAILlmRunResult, GenericAILlmStreamChunk } from "@generic-ai/core";
import { renderBenchmarkReportMarkdown, type BenchmarkSpec, type HarnessDsl, type MissionSpec } from "@generic-ai/sdk";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_PATHS = [
  resolve(EXAMPLE_ROOT, "candidates", "direct-tool-executor.json"),
  resolve(EXAMPLE_ROOT, "candidates", "policy-gated-tool-planner.json"),
] as const;

export interface PolicyToolsFixture {
  readonly benchmark: BenchmarkSpec;
  readonly mission: MissionSpec;
  readonly harnesses: Readonly<Record<string, HarnessDsl>>;
}

export interface PolicyToolsSmokeResult {
  readonly fixture: PolicyToolsFixture;
  readonly markdown: string;
  readonly report: Awaited<ReturnType<typeof runHarnessBenchmark>>["report"];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

export async function loadPolicyToolsFixture(): Promise<PolicyToolsFixture> {
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
    model: "deterministic-meso-adapter",
    outputText: [
      `Candidate ${context.candidateId}`,
      `Trial ${context.trialId}`,
      outputText,
    ].join("\n"),
  });
}

function deterministicOutput(context: HarnessBenchmarkRuntimeContext): string {
  if (context.candidateId === "policy-gated-tool-planner") {
    return [
      "POLICY_OK:refund-30d-low-value",
      "TOOL_SEQUENCE:policy_check>read_order>refund_order>write_audit_note",
      "REFUND_ID:rf_2026_0429",
      "Artifacts: tool-plan.json audit-note.md",
    ].join("\n");
  }

  return [
    "POLICY_SKIPPED",
    "TOOL_SEQUENCE:read_order>refund_order",
    "REFUND_ID:rf_unverified",
    "Artifacts: tool-plan.json",
  ].join("\n");
}

export async function createDeterministicPolicyToolsRuntime(
  context: HarnessBenchmarkRuntimeContext,
): Promise<GenericAILlmRuntime> {
  const run = async (): Promise<GenericAILlmRunResult> =>
    createResult(context, deterministicOutput(context));

  return Object.freeze({
    adapter: "openai-codex",
    model: "deterministic-meso-adapter",
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

export async function runPolicyToolsSmoke(): Promise<PolicyToolsSmokeResult> {
  const fixture = await loadPolicyToolsFixture();
  const result = await runHarnessBenchmark({
    ...fixture,
    createRuntime: createDeterministicPolicyToolsRuntime,
    now: () => "2026-04-29T00:00:00.000Z",
  });

  return Object.freeze({
    fixture,
    markdown: renderBenchmarkReportMarkdown(result.report),
    report: result.report,
  });
}
