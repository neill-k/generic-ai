import {
  compileHarnessDsl,
  createCanonicalEvent,
  type BenchmarkSpec,
  type CompiledHarness,
  type GoalEvalSuiteSpec,
  type GoalSpec,
  HARNESS_SCHEMA_VERSION,
  type HarnessDsl,
  type MissionSpec,
  runGoalEvalSuite,
} from "@generic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createTopologyGoalEvalExecutor,
  runHarnessBenchmark,
  type TopologyActorInvocation,
  type TopologyActorResult,
} from "../../src/harness/index.js";
import * as runtimeFactory from "../../src/runtime/llm.js";

const harness: HarnessDsl = {
  kind: "generic-ai.harness",
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "harness.report-pipeline",
  packages: [{ id: "protocol", package: "@generic-ai/protocol-pipeline" }],
  agents: [
    { id: "researcher", role: "researcher", packageRefs: ["protocol"] },
    { id: "writer", role: "writer", packageRefs: ["protocol"] },
  ],
  protocols: [
    {
      id: "pipeline",
      protocol: "pipeline",
      packageRef: "protocol",
      actorRefs: ["researcher", "writer"],
    },
  ],
};

function compiled(): CompiledHarness {
  const result = compileHarnessDsl(harness);
  if (result.compiled === undefined) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.compiled;
}

const goal: GoalSpec = {
  id: "q3-summary",
  objective: "Summarize Q3 revenue as JSON.",
  definitionOfDone: ["Total is reported", "The ledger was read", "A writer produced the answer"],
  validators: [
    {
      id: "total",
      kind: "numeric",
      source: { outputPath: "total" },
      operator: "eq",
      value: 42,
    },
    {
      id: "read-ledger",
      kind: "trace",
      require: [
        { tool: "read_file", argsInclude: { path: "ledger.csv" }, role: "researcher" },
        { event: "actor.completed", role: "writer" },
      ],
      ordered: true,
    },
  ],
};

/** Researcher reads the ledger (tool event + usage); writer returns JSON. */
function actorRunner(options: { readonly skipLedger?: boolean } = {}) {
  const calls: TopologyActorInvocation[] = [];
  const runner = async (invocation: TopologyActorInvocation): Promise<TopologyActorResult> => {
    calls.push(invocation);
    const runId = `${invocation.runId}:${invocation.actor.id}`;
    const ctx = {
      scopeId: "scope/eval",
      runId,
      rootSessionId: runId,
      sessionId: runId,
    };
    const usage = createCanonicalEvent({
      ...ctx,
      name: "usage.recorded",
      data: {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        usage: {
          input: 300,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 400,
          cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        },
        agentId: invocation.actor.id,
      },
    });
    if (invocation.actor.id === "researcher") {
      return {
        status: "succeeded",
        outputText: "Ledger total is 42.",
        events: [
          ...(options.skipLedger === true
            ? []
            : [
                createCanonicalEvent({
                  ...ctx,
                  name: "tool.call.completed",
                  data: {
                    toolName: "read_file",
                    args: { path: "ledger.csv" },
                    roleId: "researcher",
                  },
                }),
              ]),
          usage,
        ],
      };
    }
    return { status: "succeeded", outputText: JSON.stringify({ total: 42 }), events: [usage] };
  };
  return { calls, runner };
}

describe("createTopologyGoalEvalExecutor", () => {
  it("runs each attempt through the real topology and scores it from the trace", async () => {
    const suite: GoalEvalSuiteSpec = {
      kind: "generic-ai.goal-eval-suite",
      id: "finance",
      cases: [{ id: "q3", goal }],
      trials: { count: 2 },
      gate: { minPassK: 1, maxTokensPerCompletedGoal: 1000 },
    };
    const scripted = actorRunner();
    const report = await runGoalEvalSuite({
      suite,
      execute: createTopologyGoalEvalExecutor({
        compiled: compiled(),
        createRunner: () => scripted.runner,
      }),
    });

    expect(scripted.calls.map((call) => call.actor.id)).toEqual([
      "researcher",
      "writer",
      "researcher",
      "writer",
    ]);
    expect(scripted.calls[0]?.instruction).toContain("Summarize Q3 revenue as JSON.");
    expect(report.passed).toBe(2);
    expect(report.cases[0]?.passK.value).toBe(1);
    expect(report.checks.trace).toEqual({ total: 2, passed: 2, score: 1 });
    expect(report.efficiency.tokensPerCompletedGoal).toBe(800);
    expect(report.efficiency.costPerCompletedGoalUsd).toBeCloseTo(0.004);
    expect(report.gate).toEqual({ passed: true, reasons: [] });
  });

  it("fails attempts whose trace lacks the required action", async () => {
    const report = await runGoalEvalSuite({
      suite: { kind: "generic-ai.goal-eval-suite", id: "finance", cases: [{ id: "q3", goal }] },
      execute: createTopologyGoalEvalExecutor({
        compiled: compiled(),
        createRunner: () => actorRunner({ skipLedger: true }).runner,
      }),
    });
    expect(report.passed).toBe(0);
    expect(report.findings[0]).toMatchObject({ validatorId: "read-ledger", kind: "trace" });
  });
});

describe("runHarnessBenchmark with a topology and a mission goal", () => {
  const mission: MissionSpec = {
    kind: "generic-ai.mission",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: "mission.q3",
    objective: "Summarize Q3 revenue as JSON.",
    objectiveClass: "analysis",
    goal,
  };
  const benchmark: BenchmarkSpec = {
    kind: "generic-ai.benchmark",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: "bench.q3",
    missionRef: "mission.q3",
    hypothesis: "A two-step pipeline reaches the goal.",
    candidates: [{ id: "pipeline", harnessRef: "pipeline" }],
    primaryMetric: "task_success",
  };

  it("runs the protocol topology instead of one prompt to one model", async () => {
    const createRuntime = vi.spyOn(runtimeFactory, "createGenericAILlmRuntime");
    const scripted = actorRunner();
    const result = await runHarnessBenchmark({
      benchmark,
      mission,
      harnesses: { pipeline: harness },
      createActorRunner: () => scripted.runner,
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(scripted.calls.map((call) => call.actor.id)).toEqual(["researcher", "writer"]);
    expect(scripted.calls[0]?.instruction).toContain("Definition of done");
    const trial = result.trialResults[0];
    const metric = (id: string) => trial?.metrics.find((entry) => entry.metricId === id)?.value;
    expect(metric("task_success")).toBe(1);
    expect(metric("goal_complete")).toBe(1);
    expect(metric("handoff_count")).toBeGreaterThan(0);
    expect(metric("cost_usd")).toBeCloseTo(0.004);
    expect(trial?.usage).toMatchObject({ totalTokens: 800, goalsCompleted: 1 });
    expect(trial?.traceEvents.filter((event) => event.type === "actor.invoked")).toHaveLength(2);
    expect(trial?.diagnostics.completeness).toBe(1);
  });

  it("does not count a trial as a success when the goal is incomplete", async () => {
    const result = await runHarnessBenchmark({
      benchmark,
      mission,
      harnesses: { pipeline: harness },
      createActorRunner: () => actorRunner({ skipLedger: true }).runner,
    });
    const metrics = result.trialResults[0]?.metrics ?? [];
    expect(metrics.find((entry) => entry.metricId === "task_success")?.value).toBe(0);
    expect(metrics.find((entry) => entry.metricId === "goal_validators_passed")?.value).toBe(0.5);
  });
});
