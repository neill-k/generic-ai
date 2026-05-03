import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_SCHEMA_VERSION,
  type BenchmarkSpec,
  type HarnessDsl,
  type MissionSpec,
} from "@generic-ai/sdk";
import { runHarnessBenchmark } from "../../src/harness/index.js";
import * as runtimeFactory from "../../src/runtime/llm.js";
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
    model: "gpt-5.5",
    run: vi.fn(async () => ({
      adapter: "openai-codex" as const,
      model: "gpt-5.5",
      outputText,
    })),
    async *stream() {
      yield {
        type: "response",
        response: {
          adapter: "openai-codex" as const,
          model: "gpt-5.5",
          outputText,
        },
      };
    },
    close: vi.fn(async () => undefined),
  };
}

function failingRuntime(error: Error): GenericAILlmRuntime {
  return {
    adapter: "openai-codex",
    model: "gpt-5.5",
    run: vi.fn(async () => {
      throw error;
    }),
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        async next() {
          throw error;
        },
      }),
    }),
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
    expect(prompts[0]).toContain("Replay id:");
    expect(prompts[0]).toContain("Seed: seed-1:1");
    expect(result.compiledHarnesses[harness.id]?.sourceId).toBe(harness.id);
    expect(result.trialResults).toHaveLength(1);
    expect(result.report.candidates[0]?.recommendation).toBe("insufficient_evidence");
    expect(result.report.confidence.level).toBe("insufficient_evidence");
    expect(result.report.evidence.traceEventCount).toBeGreaterThan(0);
    expect(result.trialResults[0]?.seed).toBe("seed-1:1");
    expect(result.trialResults[0]?.replayId).toContain("pipeline:trial:1");
    expect(result.trialResults[0]?.traceEvents[0]?.seed).toBe("seed-1:1");
    expect(result.trialResults[0]?.traceEvents[0]?.replayId).toContain("pipeline:trial:1");
    const metricIds = result.trialResults[0]?.metrics.map((metric) => metric.metricId) ?? [];
    expect(metricIds).toEqual(
      expect.arrayContaining(["task_success", "tests_passed", "rework_rate"]),
    );
    const artifactUri = result.trialResults[0]?.artifacts[0]?.uri;
    expect(artifactUri).toBeDefined();
    if (artifactUri === undefined) {
      throw new Error("Expected benchmark runner to emit an assistant output artifact.");
    }
    const parsedArtifactUri = new URL(artifactUri);
    expect(parsedArtifactUri.protocol).toBe("memory:");
    expect(parsedArtifactUri.host).toBe("");
    expect(artifactUri).toMatch(/^memory:\/\/\/benchmark\.shootout%3A/u);
    expect(artifactUri).toContain("/pipeline%3Atrial%3A1/assistant-output");
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

  it("scores required artifact success criteria", async () => {
    const result = await runHarnessBenchmark({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
      },
      mission: {
        ...mission,
        expectedArtifacts: [],
        successCriteria: {
          requiredSubstrings: ["LOGIN_DONE"],
          requiredArtifacts: ["README.md", "setup.md"],
        },
      },
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => fakeRuntime("LOGIN_DONE README.md"),
    });

    const metrics = result.trialResults[0]?.metrics ?? [];
    expect(metrics.find((metric) => metric.metricId === "task_success")?.value).toBe(0);
    expect(metrics.find((metric) => metric.metricId === "artifact_completeness")?.value).toBe(0);
    expect(metrics.find((metric) => metric.metricId === "tests_passed")?.value).toBe(0);
    expect(metrics.find((metric) => metric.metricId === "rework_rate")?.value).toBe(0);
  });

  it("records runtime failures as failed trials instead of aborting the benchmark", async () => {
    const result = await runHarnessBenchmark({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
      },
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => failingRuntime(new Error("provider unavailable")),
    });

    const trial = result.trialResults[0];
    expect(trial).toBeDefined();
    if (trial === undefined) {
      throw new Error("Expected a failed trial result.");
    }

    expect(trial.metrics.find((metric) => metric.metricId === "task_success")?.value).toBe(0);
    expect(trial.metrics.find((metric) => metric.metricId === "tests_passed")?.value).toBe(0);
    expect(trial.traceEvents.some((event) => event.type === "diagnostic")).toBe(true);
    expect(trial.toolRecovery?.[0]).toMatchObject({
      caseRef: "runtime.run",
      toolRef: "runtime.adapter",
      status: "failed",
      error: {
        kind: "upstream_unavailable",
        safeMessage: "Runtime failed: provider unavailable",
      },
    });
    expect(result.report.toolRecovery?.failedAttemptCount).toBe(1);
    expect(trial.artifacts[0]?.summary).toContain("provider unavailable");
    expect(result.report.evidence.metricCount).toBeGreaterThan(0);
  });

  it("passes configured fault-injection cases into the benchmark prompt", async () => {
    const prompts: string[] = [];
    await runHarnessBenchmark({
      benchmark: {
        ...benchmark,
        validity: {
          minimumTrialsForRecommendation: 1,
        },
        faultInjections: [
          {
            id: "tool-timeout",
            boundary: "tool",
            perturbation: "timeout",
            targetRef: "tool.shell",
            expectedBehavior: "fallback",
            firstViolatedContract: "tool.result.deadline",
          },
        ],
      },
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async (context) => {
        prompts.push(context.prompt);
        return fakeRuntime("LOGIN_DONE README.md");
      },
    });

    expect(prompts[0]).toContain("Fault injections:");
    expect(prompts[0]).toContain("tool-timeout");
    expect(prompts[0]).toContain("boundary=tool");
    expect(prompts[0]).toContain("first violated contract=tool.result.deadline");
  });

  it("emits unique trace event ids across repeated trials", async () => {
    const result = await runHarnessBenchmark({
      benchmark: {
        ...benchmark,
        trials: {
          count: 2,
          pairing: "paired",
        },
        validity: {
          minimumTrialsForRecommendation: 1,
        },
      },
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => fakeRuntime("LOGIN_DONE README.md"),
    });

    const eventIds = result.trialResults.flatMap((trial) =>
      trial.traceEvents.map((event) => event.id),
    );

    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("emits unique run ids across repeated benchmark executions", async () => {
    const first = await runHarnessBenchmark({
      benchmark,
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => fakeRuntime("LOGIN_DONE README.md"),
    });
    const second = await runHarnessBenchmark({
      benchmark,
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => fakeRuntime("LOGIN_DONE README.md"),
    });

    const firstRunId = first.trialResults[0]?.traceEvents[0]?.runId;
    const secondRunId = second.trialResults[0]?.traceEvents[0]?.runId;

    expect(firstRunId).toBeDefined();
    expect(secondRunId).toBeDefined();
    expect(firstRunId).not.toBe(secondRunId);
  });

  it("defaults missing trials to one smoke-compatible run", async () => {
    const { trials: _trials, validity: _validity, ...benchmarkWithoutTrials } = benchmark;
    const result = await runHarnessBenchmark({
      benchmark: {
        ...benchmarkWithoutTrials,
        smoke: true,
        minTrials: 1,
      },
      mission,
      harnesses: {
        [harness.id]: harness,
      },
      createRuntime: async () => fakeRuntime("LOGIN_DONE README.md"),
    });

    expect(result.trialResults).toHaveLength(1);
    expect(result.report.confidence.level).toBe("bounded_recommendation");
  });

  it("validates benchmark trial counts before runtime execution", async () => {
    const createRuntime = vi.fn(async () => fakeRuntime("not reached"));

    await expect(
      runHarnessBenchmark({
        benchmark: {
          ...benchmark,
          trials: {
            count: 0,
            pairing: "paired",
          },
        },
        mission,
        harnesses: {
          [harness.id]: harness,
        },
        createRuntime,
      }),
    ).rejects.toThrow("Benchmark trials.count must be a positive integer");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("inherits the compiled harness model when runtimeOptions omit a model", async () => {
    const runtime = fakeRuntime("LOGIN_DONE README.md");
    const createRuntime = vi
      .spyOn(runtimeFactory, "createGenericAILlmRuntime")
      .mockResolvedValue(runtime);
    const primaryAgent = harness.agents[0];
    if (primaryAgent === undefined) {
      throw new Error("Expected test harness to include at least one agent.");
    }
    const harnessWithModel: HarnessDsl = {
      ...harness,
      agents: [
        {
          ...primaryAgent,
          instructions: "Use the harness-specific model.",
          model: "gpt-5.5",
        },
      ],
    };

    try {
      await runHarnessBenchmark({
        benchmark: {
          ...benchmark,
          validity: {
            minimumTrialsForRecommendation: 1,
          },
        },
        mission,
        harnesses: {
          [harnessWithModel.id]: harnessWithModel,
        },
        runtimeOptions: {
          adapter: "openai-codex",
        },
      });

      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: "openai-codex",
          instructions: "Use the harness-specific model.",
          model: "gpt-5.5",
        }),
      );
    } finally {
      createRuntime.mockRestore();
    }
  });
});
