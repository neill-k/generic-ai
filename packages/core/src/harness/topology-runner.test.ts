import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentHarnessRunInput,
  type CompiledHarness,
  compileHarnessDsl,
  createMockRuntimeAdapter,
  HARNESS_SCHEMA_VERSION,
  type HarnessDsl,
  type JsonObject,
  type ProtocolPlugin,
  sealGoal,
} from "@generic-ai/sdk";
import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";
import { runAgentHarnessTopology } from "./agent-harness.js";
import {
  createAdapterTopologyActorRunner,
  resolveTopologyActorRole,
  runHarnessTopology,
  type TopologyActorInvocation,
  type TopologyActorResult,
} from "./topology-runner.js";

function compile(input: {
  readonly id: string;
  readonly protocol: string;
  readonly agents: readonly { readonly id: string; readonly role: string }[];
  readonly config?: JsonObject;
  readonly relationships?: HarnessDsl["relationships"];
}): CompiledHarness {
  const result = compileHarnessDsl({
    kind: "generic-ai.harness",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: input.id,
    packages: [{ id: "protocol", package: `@generic-ai/protocol-${input.protocol}` }],
    agents: input.agents.map((agent) => ({ ...agent, packageRefs: ["protocol"] })),
    spaces: [{ id: "board", kind: "workspace", visibility: "shared" }],
    ...(input.relationships === undefined ? {} : { relationships: input.relationships }),
    protocols: [
      {
        id: `${input.protocol}-binding`,
        protocol: input.protocol,
        packageRef: "protocol",
        actorRefs: input.agents.map((agent) => agent.id),
        ...(input.config === undefined ? {} : { config: input.config }),
      },
    ],
  });
  if (result.compiled === undefined) {
    throw new Error(`Fixture failed to compile: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.compiled;
}

function scriptedRunner(
  respond: (invocation: TopologyActorInvocation) => Partial<TopologyActorResult> | string,
) {
  const calls: TopologyActorInvocation[] = [];
  return {
    calls,
    runner: async (invocation: TopologyActorInvocation): Promise<TopologyActorResult> => {
      calls.push(invocation);
      const response = respond(invocation);
      return typeof response === "string"
        ? { status: "succeeded", outputText: response }
        : { status: "succeeded", outputText: "", ...response };
    },
  };
}

describe("runHarnessTopology", () => {
  it("runs a verifier loop to a passing verdict and records a causal trace", async () => {
    const compiled = compile({
      id: "h.verifier",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
    });
    let reviews = 0;
    const { runner, calls } = scriptedRunner((invocation) => {
      if (invocation.actor.id === "critic") {
        reviews += 1;
        return reviews === 1 ? "Tests missing.\nVERDICT: FAIL" : "VERDICT: PASS";
      }
      return `candidate ${invocation.attempt}/${invocation.action.payload?.["iteration"]}`;
    });

    const result = await runHarnessTopology({ compiled, instruction: "Fix the bug.", runner });

    expect(result.status).toBe("succeeded");
    expect(result.protocol).toBe("verifier-loop");
    expect(result.bindingId).toBe("verifier-loop-binding");
    expect(result.outputText).toBe("candidate 1/2");
    expect(calls.map((call) => call.actor.id)).toEqual(["solver", "critic", "solver", "critic"]);
    expect(calls[2]?.prompt).toContain("Tests missing.");
    expect(calls[0]?.prompt).toContain("Fix the bug.");
    expect(result.outcomes.map((item) => item.verdict ?? null)).toEqual([
      null,
      "fail",
      null,
      "pass",
    ]);

    const types = result.trace.map((event) => event.type);
    expect(types.filter((type) => type === "protocol.action.planned")).toHaveLength(4);
    expect(types.filter((type) => type === "actor.completed")).toHaveLength(4);
    const completed = result.trace.find((event) => event.type === "actor.completed");
    const invoked = result.trace.find((event) => event.id === completed?.causedByEventId);
    expect(invoked?.type).toBe("actor.invoked");
    expect(result.trace.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect(result.trace[0]?.protocolId).toBe("@generic-ai/protocol-verifier-loop");
  });

  it("runs a pipeline stage by stage", async () => {
    const compiled = compile({
      id: "h.pipeline",
      protocol: "pipeline",
      agents: [
        { id: "plan", role: "planner" },
        { id: "build", role: "implementer" },
      ],
    });
    const { runner, calls } = scriptedRunner((invocation) => `${invocation.actor.id} done`);
    const result = await runHarnessTopology({ compiled, instruction: "Do it.", runner });
    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("build done");
    expect(result.steps).toBe(2);
    expect(calls[1]?.context).toContain("plan done");
  });

  it("runs hierarchy delegations concurrently and synthesizes", async () => {
    const compiled = compile({
      id: "h.hierarchy",
      protocol: "hierarchy",
      agents: [
        { id: "boss", role: "manager" },
        { id: "a", role: "implementer" },
        { id: "b", role: "implementer" },
        { id: "c", role: "implementer" },
      ],
    });
    let active = 0;
    let peak = 0;
    const result = await runHarnessTopology({
      compiled,
      instruction: "Build three parts.",
      maxConcurrency: 2,
      runner: async (invocation) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (invocation.action.payload?.["phase"] === "plan") {
          return {
            status: "succeeded",
            outputText:
              '```json\n{"assignments":[{"actorRef":"a","task":"part A"},{"actorRef":"b","task":"part B"},{"actorRef":"c","task":"part C"}]}\n```',
          };
        }
        if (invocation.action.payload?.["phase"] === "synthesize") {
          return { status: "succeeded", outputText: `merged:\n${invocation.context}` };
        }
        return { status: "succeeded", outputText: `${invocation.task} built` };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(peak).toBe(2);
    expect(result.outputText).toContain("part A built");
    expect(result.outputText).toContain("part C built");
    expect(result.steps).toBe(3);
  });

  it("runs a squad over configured work items", async () => {
    const compiled = compile({
      id: "h.squad",
      protocol: "squad",
      agents: [
        { id: "x", role: "worker" },
        { id: "y", role: "worker" },
      ],
      config: { workItems: ["w1", "w2", "w3"] },
    });
    const { runner, calls } = scriptedRunner(
      (invocation) => `${invocation.actor.id}:${invocation.action.payload?.["workItemId"]}`,
    );
    const result = await runHarnessTopology({ compiled, instruction: "Split it.", runner });
    expect(result.status).toBe("succeeded");
    expect(calls.map((call) => call.action.kind)).toEqual([
      "claim_work",
      "claim_work",
      "claim_work",
    ]);
    expect(result.outputText).toContain("x:item-3");
  });

  it("retries failed actor attempts and honours non-retryable failures", async () => {
    const compiled = compile({
      id: "h.retry",
      protocol: "pipeline",
      agents: [{ id: "only", role: "implementer" }],
    });
    let attempts = 0;
    const flaky = await runHarnessTopology({
      compiled,
      instruction: "Flaky.",
      maxAttempts: 3,
      runner: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient");
        }
        return { status: "succeeded", outputText: "finally" };
      },
    });
    expect(flaky.status).toBe("succeeded");
    expect(flaky.outcomes[0]?.attempt).toBe(3);
    expect(flaky.trace.filter((event) => event.type === "actor.invoked")).toHaveLength(3);

    let permanentAttempts = 0;
    const permanent = await runHarnessTopology({
      compiled,
      instruction: "Permanent.",
      maxAttempts: 3,
      runner: async () => {
        permanentAttempts += 1;
        return { status: "failed", outputText: "", failureMessage: "denied", retryable: false };
      },
    });
    expect(permanent.status).toBe("failed");
    expect(permanentAttempts).toBe(1);
    expect(permanent.failureMessage).toContain("denied");
  });

  it("stops at the step budget, on cancellation, and at the deadline", async () => {
    const compiled = compile({
      id: "h.budget",
      protocol: "verifier-loop",
      agents: [
        { id: "s", role: "solver" },
        { id: "c", role: "critic" },
      ],
      config: { maxIterations: 10 },
    });
    const rejecting = scriptedRunner(() => "VERDICT: FAIL").runner;
    const budget = await runHarnessTopology({
      compiled,
      instruction: "Never good enough.",
      runner: rejecting,
      maxSteps: 3,
    });
    expect(budget.status).toBe("failed");
    expect(budget.errorCategory).toBe("budget_exceeded");
    expect(budget.steps).toBe(3);

    const controller = new AbortController();
    const cancelled = await runHarnessTopology({
      compiled,
      instruction: "Cancel me.",
      signal: controller.signal,
      runner: async () => {
        controller.abort();
        return { status: "succeeded", outputText: "VERDICT: FAIL" };
      },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCategory).toBe("cancelled");
    expect(cancelled.outcomes).toHaveLength(1);

    const late = await runHarnessTopology({
      compiled,
      instruction: "Too late.",
      deadline: new Date(Date.now() - 1000),
      runner: rejecting,
    });
    expect(late.status).toBe("failed");
    expect(late.errorCategory).toBe("deadline_exceeded");
    expect(late.outcomes).toHaveLength(0);
  });

  it("blocks on validation errors and unknown protocols without invoking actors", async () => {
    const missingCritic = compile({
      id: "h.invalid",
      protocol: "verifier-loop",
      agents: [{ id: "s", role: "solver" }],
    });
    const { runner, calls } = scriptedRunner(() => "never");
    const invalid = await runHarnessTopology({ compiled: missingCritic, instruction: "x", runner });
    expect(invalid.status).toBe("blocked");
    expect(invalid.diagnostics[0]?.code).toBe("missing_protocol_actor");

    const unknown = await runHarnessTopology({
      compiled: compile({ id: "h.custom", protocol: "swarm", agents: [{ id: "s", role: "x" }] }),
      instruction: "x",
      runner,
    });
    expect(unknown.status).toBe("blocked");
    expect(unknown.diagnostics[0]?.code).toBe("unknown_protocol");

    const missingBinding = await runHarnessTopology({
      compiled: missingCritic,
      protocol: "hierarchy",
      instruction: "x",
      runner,
    });
    expect(missingBinding.diagnostics[0]?.code).toBe("missing_protocol_binding");
    expect(calls).toHaveLength(0);
  });

  it("supports custom protocols with approvals and terminal actions", async () => {
    const approvals: string[] = [];
    const gated: ProtocolPlugin = {
      manifest: { id: "@acme/protocol-gated", name: "Gated", version: "1.0.0", protocol: "gated" },
      reduce: ({ compiled, outcomes = [] }) => {
        const approval = outcomes.find((item) => item.kind === "request_approval");
        if (approval === undefined) {
          return {
            state: { status: "ready" },
            actions: [{ id: "approve", idempotencyKey: "approve", kind: "request_approval" }],
            summary: { status: "ready", actionCount: 1, blockerCount: 0 },
          };
        }
        if (approval.verdict !== "pass") {
          return {
            state: { status: "failed" },
            actions: [],
            summary: { status: "failed", actionCount: 0, blockerCount: 0, notes: ["rejected"] },
          };
        }
        const work = outcomes.find((item) => item.kind === "invoke_actor");
        if (work === undefined) {
          return {
            state: { status: "ready" },
            actions: [
              {
                id: "work",
                idempotencyKey: "work",
                kind: "invoke_actor",
                actorRef: compiled.agents[0]?.id ?? "",
                payload: { task: "do the gated work" },
              },
            ],
            summary: { status: "ready", actionCount: 1, blockerCount: 0 },
          };
        }
        return {
          state: { status: "ready" },
          actions: [{ id: "complete", idempotencyKey: "complete", kind: "complete" }],
          summary: { status: "ready", actionCount: 1, blockerCount: 0 },
        };
      },
    };
    const compiled = compile({
      id: "h.gated",
      protocol: "gated",
      agents: [{ id: "w", role: "worker" }],
    });
    const { runner } = scriptedRunner((invocation) => invocation.task);

    const approved = await runHarnessTopology({
      compiled,
      instruction: "x",
      protocols: [gated],
      runner,
      approve: ({ action }) => {
        approvals.push(action.id);
        return true;
      },
    });
    expect(approved.status).toBe("succeeded");
    expect(approved.outputText).toBe("do the gated work");
    expect(approvals).toEqual(["approve"]);

    const rejected = await runHarnessTopology({
      compiled,
      instruction: "x",
      protocols: [gated],
      runner,
      approve: () => false,
    });
    expect(rejected.status).toBe("failed");

    const unattended = await runHarnessTopology({
      compiled,
      instruction: "x",
      protocols: [gated],
      runner,
    });
    expect(unattended.status).toBe("blocked");
    expect(unattended.failureMessage).toContain("approval");
  });
});

describe("createAdapterTopologyActorRunner", () => {
  it("runs actors through any AgentHarnessAdapter with per-role models", async () => {
    const compiled = compile({
      id: "h.adapter",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
    });
    const inputs: AgentHarnessRunInput[] = [];
    const adapter = createMockRuntimeAdapter({ id: "native-runtime" });
    const outputs = new Map<string, string>([
      ["solver", "candidate"],
      ["critic", "VERDICT: PASS"],
    ]);
    const runner = createAdapterTopologyActorRunner({
      adapter: {
        ...adapter,
        run: async (input, context) => {
          inputs.push(input);
          const result = await adapter.run(input, context);
          return { ...result, outputText: outputs.get(input.rootAgentId ?? "") ?? "" };
        },
      },
      harness: {
        id: "native",
        adapter: "external",
        model: "default-model",
        roles: [{ id: "critic", kind: "verifier", model: "anthropic/claude-critic" }],
      },
      workspaceRoot: "/tmp",
      context: {
        events: { emit: () => undefined },
        artifacts: { write: async () => ({ id: "a", kind: "custom", uri: "x://a" }) },
        policy: {
          evaluate: async () => ({ allowed: true, decision: {} as never }),
        },
      },
    });

    const result = await runHarnessTopology({ compiled, instruction: "Do it.", runner });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("candidate");
    expect(inputs.map((input) => [input.rootAgentId, input.harness.model])).toEqual([
      ["solver", "default-model"],
      ["critic", "anthropic/claude-critic"],
    ]);
    expect(inputs[0]?.harness.roles?.[0]).toMatchObject({ id: "solver", kind: "builder" });
    expect(inputs[1]?.instruction).toContain("candidate");
  });

  it("does not retry adapter failures that are policy or budget stops", async () => {
    const compiled = compile({
      id: "h.adapter.denied",
      protocol: "pipeline",
      agents: [{ id: "only", role: "implementer" }],
    });
    let calls = 0;
    const base = createMockRuntimeAdapter();
    const runner = createAdapterTopologyActorRunner({
      adapter: {
        ...base,
        run: async (input, context) => {
          calls += 1;
          const result = await base.run(input, context);
          return {
            ...result,
            status: "failed",
            failureMessage: "policy denied",
            errorCategory: "policy_denied",
          };
        },
      },
      harness: { id: "native", adapter: "external" },
      workspaceRoot: "/tmp",
      context: () => ({
        events: { emit: () => undefined },
        artifacts: { write: async () => ({ id: "a", kind: "custom", uri: "x://a" }) },
        policy: { evaluate: async () => ({ allowed: true, decision: {} as never }) },
      }),
    });
    const result = await runHarnessTopology({
      compiled,
      instruction: "x",
      runner,
      maxAttempts: 3,
    });
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });
});

describe("resolveTopologyActorRole", () => {
  it("maps DSL role names onto harness role policies", () => {
    expect(resolveTopologyActorRole({ id: "a", role: "implementer" })).toMatchObject({
      id: "a",
      kind: "builder",
      readOnly: false,
    });
    expect(resolveTopologyActorRole({ id: "c", role: "Critic" }).kind).toBe("verifier");
    expect(resolveTopologyActorRole({ id: "m", role: "manager" })).toMatchObject({
      kind: "planner",
      readOnly: true,
    });
    expect(resolveTopologyActorRole({ id: "z", role: "poet" })).toMatchObject({
      kind: "custom",
      readOnly: true,
    });
    expect(
      resolveTopologyActorRole({ id: "z", role: "poet", instructions: "rhyme" }, [
        { id: "poet", kind: "builder" },
      ]),
    ).toMatchObject({ id: "z", kind: "builder", instructions: "rhyme" });
  });
});

describe("runAgentHarnessTopology", () => {
  it("runs each actor as a policy-scoped Pi role session and writes topology artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-topology-"));
    const compiled = compile({
      id: "h.pi-verifier",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
    });
    const toolSets: Record<string, string[]> = {};
    const prompts: string[] = [];
    let sessionIndex = 0;

    const result = await runAgentHarnessTopology({
      harness: {
        id: "pi-topology",
        adapter: "pi",
        model: "fake-model",
        policyProfile: "benchmark-container",
      },
      compiled,
      instruction: "Fix the failing test.",
      workspaceRoot: root,
      artifactDir: join(root, "artifacts"),
      runId: "topology-run",
      sessionInputs: {
        agentDir: root,
        authStorage: {} as never,
        modelRegistry: {} as never,
        model: {} as never,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory(),
      },
      capabilities: {
        fileTools: {
          piTools: [
            {
              name: "read",
              description: "read",
              execute: async () => ({}),
              genericAi: { effects: ["fs.read"] },
            },
            {
              name: "write",
              description: "write",
              execute: async () => ({}),
              genericAi: { effects: ["fs.write"] },
            },
          ] as never,
        },
      },
      factories: {
        createAgentSession: async (options) => {
          if (options === undefined) {
            throw new Error("Expected createAgentSession options.");
          }
          const sessionId = `session-${++sessionIndex}`;
          const messages: unknown[] = [];
          return {
            session: {
              sessionId,
              messages,
              subscribe() {
                return () => undefined;
              },
              async prompt(prompt: string) {
                prompts.push(prompt);
                const isCritic = prompt.includes('role "critic"');
                toolSets[isCritic ? "critic" : "solver"] = [...(options.tools ?? [])];
                const stop = options.customTools?.find(
                  (tool) => tool.name === STOP_AND_RESPOND_TOOL_NAME,
                );
                await stop?.execute(
                  "stop",
                  { response: isCritic ? "Looks right.\nVERDICT: PASS" : "patched the test" },
                  undefined,
                  undefined,
                  {} as never,
                );
              },
            },
          } as never;
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("patched the test");
    expect(prompts[0]).toContain('You are role "solver" (builder)');
    expect(prompts[1]).toContain("patched the test");
    expect(toolSets["solver"]).toEqual(expect.arrayContaining(["read", "write"]));
    expect(toolSets["critic"]).toContain("read");
    expect(toolSets["critic"]).not.toContain("write");

    const names = result.events.map((event) => event.name);
    expect(names.filter((name) => name === "handoff.completed")).toHaveLength(2);
    expect(names).toContain("policy.decision");
    expect(result.projections.some((projection) => projection.type === "handoff.completed")).toBe(
      true,
    );
    expect(result.policyDecisions.some((decision) => decision.actorId === "critic")).toBe(true);

    const artifactIds = result.artifacts.map((artifact) => artifact.id);
    expect(artifactIds).toEqual(
      expect.arrayContaining(["topology-trace", "topology-outcomes", "harness-summary"]),
    );
    const summaryPath = result.artifacts.find(
      (artifact) => artifact.id === "harness-summary",
    )?.localPath;
    const summary = JSON.parse(await readFile(summaryPath ?? "", "utf8")) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      mode: "topology",
      protocol: "verifier-loop",
      status: "succeeded",
    });
  });
});

describe("runHarnessTopology with a sealed goal", () => {
  const goal = sealGoal({
    id: "goal.answer",
    objective: "Produce the answer 42.",
    definitionOfDone: ["The output contains the number 42."],
    validators: [
      {
        id: "has-42",
        kind: "check",
        checkRef: "contains-42",
        description: "Output mentions 42",
        fixHint: "Include the number 42 in the final answer.",
      },
    ],
  });
  const goalValidators = {
    checks: {
      "contains-42": ({ evidence }: { evidence: { outputText?: string } }) => ({
        passed: (evidence.outputText ?? "").includes("42"),
        message: "Looked for 42 in the output.",
      }),
    },
  };

  it("repairs from validator feedback until the goal is COMPLETE, then asks the critic", async () => {
    const compiled = compile({
      id: "h.goal.verifier",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
    });
    const { runner, calls } = scriptedRunner((invocation) => {
      if (invocation.actor.id === "critic") {
        return "VERDICT: PASS";
      }
      return invocation.action.payload?.["phase"] === "solve"
        ? "the answer is 41"
        : "the answer is 42";
    });

    const result = await runHarnessTopology({
      compiled,
      instruction: "Answer.",
      runner,
      goal,
      goalValidators,
    });

    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("the answer is 42");
    expect(result.goalReport?.status).toBe("COMPLETE");
    expect(result.outcomes.map((item) => `${item.kind}:${item.verdict ?? "-"}`)).toEqual([
      "invoke_actor:-",
      "validate_goal:fail",
      "invoke_actor:-",
      "validate_goal:pass",
      "review_artifact:pass",
    ]);
    expect(calls[0]?.prompt).toContain("Definition of done:");
    expect(calls[0]?.goalBrief).toContain("goal.answer");
    expect(calls[1]?.context).toContain("GOAL INCOMPLETE");
    expect(calls[1]?.context).toContain("Include the number 42");
    expect(result.trace.filter((event) => event.type === "grader.completed")).toHaveLength(2);
    // The final output was already validated, so no extra gate run happened.
    expect(calls).toHaveLength(3);
  });

  it("fails a verifier loop that never satisfies the goal, even when the critic would pass", async () => {
    const compiled = compile({
      id: "h.goal.never",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
      config: { maxIterations: 2 },
    });
    const { runner, calls } = scriptedRunner((invocation) =>
      invocation.actor.id === "critic" ? "VERDICT: PASS" : "nope",
    );
    const result = await runHarnessTopology({
      compiled,
      instruction: "Answer.",
      runner,
      goal,
      goalValidators,
    });
    expect(result.status).toBe("failed");
    expect(result.goalReport?.status).toBe("INCOMPLETE");
    expect(calls.some((call) => call.actor.id === "critic")).toBe(false);
  });

  it("gates any protocol's success on the goal", async () => {
    const compiled = compile({
      id: "h.goal.pipeline",
      protocol: "pipeline",
      agents: [{ id: "builder", role: "implementer" }],
    });
    const wrong = await runHarnessTopology({
      compiled,
      instruction: "Answer.",
      runner: scriptedRunner(() => "the answer is 7").runner,
      goal,
      goalValidators,
    });
    expect(wrong.status).toBe("failed");
    expect(wrong.failureMessage).toContain("GOAL INCOMPLETE");
    expect(wrong.goalReport?.complete).toBe(false);

    const right = await runHarnessTopology({
      compiled,
      instruction: "Answer.",
      runner: scriptedRunner(() => "the answer is 42").runner,
      goal,
      goalValidators,
    });
    expect(right.status).toBe("succeeded");
    expect(right.goalReport?.complete).toBe(true);
  });

  it("treats a missing host check as a blocking validator error", async () => {
    const compiled = compile({
      id: "h.goal.nocheck",
      protocol: "pipeline",
      agents: [{ id: "builder", role: "implementer" }],
    });
    const result = await runHarnessTopology({
      compiled,
      instruction: "Answer.",
      runner: scriptedRunner(() => "42").runner,
      goal,
    });
    expect(result.status).toBe("failed");
    expect(result.goalReport?.summary.errored).toBe(1);
  });
});
