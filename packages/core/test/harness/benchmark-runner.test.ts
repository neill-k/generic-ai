import { describe, expect, it, vi } from "vitest";
import { HARNESS_SCHEMA_VERSION, type BenchmarkSpec, type HarnessDsl, type MissionSpec } from "@generic-ai/sdk";
import { runHarnessBenchmark } from "../../src/harness/index.js";
import type { GenericAILlmRuntime } from "../../src/runtime/index.js";

const mission: MissionSpec = {
  kind: "generic-ai.mission",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "mission.oauth-login",
  objective: "Add a tiny OAuth login route and document it.",
  objectiveClass: "coding",
  successCriteria: {
    requiredSubstrings: ["LOGIN_DONE"],
  },
  expectedArtifacts: [
    {
      id: "artifact.readme",
      name: "README.md",
      kind: "file",
    },
  ],
};

const harness: HarnessDsl = {
  kind: "generic-ai.harness",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "harness.pipeline",
  packages: [
    {
      id: "protocol.pipeline",
      package: "@generic-ai/protocol-pipeline",
      version: "0.1.0",
    },
  ],
  agents: [
    {
      id: "implementer",
      role: "implementer",
      instructions: "Implement the requested coding mission.",
      packageRefs: ["protocol.pipeline"],
    },
  ],
  protocols: [
    {
      id: "pipeline",
      protocol: "pipeline",
      packageRef: "protocol.pipeline",
      actorRefs: ["implementer"],
    },
  ],
};

const benchmark: BenchmarkSpec = {
  kind: "generic-ai.benchmark",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "benchmark.shootout",
  missionRef: mission.id,
  hypothesis: "Pipeline can complete the mission with low overhead.",
  candidates: [
    {
      id: "pipeline",
      harnessRef: harness.id,
    },
  ],
  primaryMetric: "task_success",
  guardrailMetrics: ["trace_completeness", "cost_usd"],
  trials: {
    count: 1,
    pairing: "paired",
    seed: "seed-1",
  },
  validity: {
    minimumTrialsForRecommendation: 2,
    requireTraceCompleteness: true,
  },
  report: {
    formats: ["json", "markdown"],
    includeRecommendations: true,
  },
};

function fakeRuntime(outputText: string): GenericAILlmRuntime {
  return {
    adapter: "openai-codex",
    model: "gpt-5.4",
    run: vi.fn(async () => ({
      adapter: "openai-codex",
      model: "gpt-5.4",
      outputText,
    })),
    async *stream() {
      yield {
        type: "response",
        response: {
          adapter: "openai-codex",
          model: "gpt-5.4",
          outputText,
        },
      };
    },
    close: vi.fn(async () => undefined),
  };
}

describe("runHarnessBenchmark", () => {
  it("compiles candidate harnesses and reports insufficient evidence for underpowered runs", async () => {
    const prompts: string[] = [];
    const result = await runHarnessBenchmark({
      benchmark,
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      now: () => "2026-04-25T00:00:00.000Z",
      createRuntime: async (context) => {
        prompts.push(context.prompt);
        return fakeRuntime("LOGIN_DONE README.md");
      },
    });

    expect(prompts[0]).toContain("Add a tiny OAuth login route");
    expect(result.compiledHarnesses[harness.id]?.sourceId).toBe(harness.id);
    expect(result.trialResults).toHaveLength(1);
    expect(result.report.candidates[0]?.recommendation).toBe("insufficient_evidence");
    expect(result.report.evidence.traceEventCount).toBeGreaterThan(0);
  });

  it("fails before runtime execution when a harness cannot compile", async () => {
    const createRuntime = vi.fn(async () => fakeRuntime("not reached"));
    await expect(
      runHarnessBenchmark({
        benchmark,
        mission,
        harnesses: {
          [harness.id]: {
            ...harness,
            agents: [],
          },
        },
        createRuntime,
      }),
    ).rejects.toThrow("Harness DSL failed to compile");
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
