import { describe, expect, it } from "vitest";

import {
  compileHarnessDsl,
  createHierarchyProtocol,
  createPipelineProtocol,
  createSquadProtocol,
  createVerifierLoopProtocol,
  HARNESS_SCHEMA_VERSION,
  parseActorDirectives,
  type CompiledHarness,
  type HarnessDsl,
  type JsonObject,
  type ProtocolAction,
  type ProtocolActionOutcome,
  type ProtocolPlugin,
} from "../index.js";

function compile(input: {
  readonly id: string;
  readonly protocol: string;
  readonly agents: readonly { readonly id: string; readonly role: string }[];
  readonly actorRefs?: readonly string[];
  readonly config?: JsonObject;
  readonly relationships?: HarnessDsl["relationships"];
  readonly shared?: boolean;
}): CompiledHarness {
  const dsl: HarnessDsl = {
    kind: "generic-ai.harness",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: input.id,
    packages: [{ id: "protocol", package: `@generic-ai/protocol-${input.protocol}` }],
    agents: input.agents.map((agent) => ({ ...agent, packageRefs: ["protocol"] })),
    spaces:
      input.shared === false ? [] : [{ id: "board", kind: "workspace", visibility: "shared" }],
    ...(input.relationships === undefined ? {} : { relationships: input.relationships }),
    protocols: [
      {
        id: input.protocol,
        protocol: input.protocol,
        packageRef: "protocol",
        actorRefs: input.actorRefs ?? input.agents.map((agent) => agent.id),
        ...(input.config === undefined ? {} : { config: input.config }),
      },
    ],
  };
  const result = compileHarnessDsl(dsl);
  if (result.compiled === undefined) {
    throw new Error(`Fixture failed to compile: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.compiled;
}

function outcome(
  planned: ProtocolAction,
  overrides: Partial<ProtocolActionOutcome> = {},
): ProtocolActionOutcome {
  return {
    actionId: planned.id,
    idempotencyKey: planned.idempotencyKey,
    kind: planned.kind,
    ...(planned.actorRef === undefined ? {} : { actorRef: planned.actorRef }),
    ...(planned.payload === undefined ? {} : { payload: planned.payload }),
    status: "succeeded",
    outputText: `${planned.actorRef ?? "?"} output`,
    step: 1,
    attempt: 1,
    ...overrides,
  };
}

async function reduce(
  plugin: ProtocolPlugin,
  compiled: CompiledHarness,
  outcomes: readonly ProtocolActionOutcome[],
) {
  return plugin.reduce({
    compiled,
    state: { status: "ready" },
    events: [],
    outcomes,
    instruction: "Ship the feature.",
  });
}

describe("parseActorDirectives", () => {
  it("reads the last verdict line and the last JSON block", () => {
    expect(parseActorDirectives("Looks off.\nVERDICT: FAIL\nfixed\n**Verdict:** pass")).toEqual({
      verdict: "pass",
    });
    const parsed = parseActorDirectives(
      'Plan:\n```json\n{"assignments":[{"actorRef":"a","task":"x"}]}\n```\n```json\nnot json\n```',
    );
    expect(parsed.data).toEqual({ assignments: [{ actorRef: "a", task: "x" }] });
    expect(parseActorDirectives('```json\n{"verdict":"FAIL"}\n```\nVERDICT: PASS').verdict).toBe(
      "fail",
    );
    expect(parseActorDirectives(undefined)).toEqual({});
  });
});

describe("pipeline protocol", () => {
  it("runs stages in order and hands each stage the earlier outputs", async () => {
    const compiled = compile({
      id: "h.pipeline",
      protocol: "pipeline",
      agents: [
        { id: "planner", role: "planner" },
        { id: "builder", role: "implementer" },
        { id: "reviewer", role: "reviewer" },
      ],
    });
    const plugin = createPipelineProtocol();
    expect(await plugin.validate?.(compiled)).toEqual([]);

    const outcomes: ProtocolActionOutcome[] = [];
    const order: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const next = await reduce(plugin, compiled, outcomes);
      expect(next.state.status).toBe("ready");
      expect(next.actions).toHaveLength(1);
      const planned = next.actions[0] as ProtocolAction;
      order.push(planned.actorRef ?? "");
      if (step > 0) {
        expect(planned.payload?.["context"]).toContain("planner output");
      }
      outcomes.push(outcome(planned));
    }
    expect(order).toEqual(["planner", "builder", "reviewer"]);

    const done = await reduce(plugin, compiled, outcomes);
    expect(done.state.status).toBe("done");
    expect(done.state.data?.["output"]).toBe("reviewer output");
    expect(done.actions).toEqual([]);
  });

  it("fails when a stage fails or rejects the work", async () => {
    const compiled = compile({
      id: "h.pipeline.fail",
      protocol: "pipeline",
      agents: [
        { id: "a", role: "implementer" },
        { id: "b", role: "reviewer" },
      ],
    });
    const plugin = createPipelineProtocol();
    const first = (await reduce(plugin, compiled, [])).actions[0] as ProtocolAction;
    const failed = await reduce(plugin, compiled, [
      outcome(first, { status: "failed", failureMessage: "boom" }),
    ]);
    expect(failed.state.status).toBe("failed");
    expect(failed.summary.notes?.[0]).toContain("boom");

    const second = (await reduce(plugin, compiled, [outcome(first)])).actions[0] as ProtocolAction;
    const rejected = await reduce(plugin, compiled, [
      outcome(first),
      outcome(second, { verdict: "fail" }),
    ]);
    expect(rejected.state.status).toBe("failed");
  });

  it("honours configured stage order", async () => {
    const compiled = compile({
      id: "h.pipeline.stages",
      protocol: "pipeline",
      agents: [
        { id: "a", role: "implementer" },
        { id: "b", role: "reviewer" },
      ],
      config: { stages: ["b", "a"] },
    });
    const next = await reduce(createPipelineProtocol(), compiled, []);
    expect(next.actions[0]?.actorRef).toBe("b");
  });
});

describe("verifier-loop protocol", () => {
  const compiled = compile({
    id: "h.verifier",
    protocol: "verifier-loop",
    agents: [
      { id: "solver", role: "solver" },
      { id: "critic", role: "critic" },
      { id: "repairer", role: "repairer" },
    ],
    config: { maxIterations: 2 },
  });
  const plugin = createVerifierLoopProtocol();

  it("loops solver -> critic -> repairer until the critic passes", async () => {
    const outcomes: ProtocolActionOutcome[] = [];
    const seen: string[] = [];
    const verdicts = ["fail", "pass"] as const;
    let reviews = 0;
    while (true) {
      const next = await reduce(plugin, compiled, outcomes);
      if (next.actions.length === 0) {
        expect(next.state.status).toBe("done");
        expect(next.state.data?.["output"]).toBe("repairer output");
        break;
      }
      const planned = next.actions[0] as ProtocolAction;
      seen.push(`${planned.kind}:${planned.actorRef}`);
      if (planned.actorRef === "critic") {
        outcomes.push(outcome(planned, { verdict: verdicts[reviews] ?? "pass" }));
        reviews += 1;
      } else {
        outcomes.push(outcome(planned));
      }
    }
    expect(seen).toEqual([
      "invoke_actor:solver",
      "review_artifact:critic",
      "invoke_actor:repairer",
      "review_artifact:critic",
    ]);
  });

  it("passes the candidate and critique to the repairer", async () => {
    const solve = (await reduce(plugin, compiled, [])).actions[0] as ProtocolAction;
    const review = (await reduce(plugin, compiled, [outcome(solve)])).actions[0] as ProtocolAction;
    const repair = (
      await reduce(plugin, compiled, [
        outcome(solve),
        outcome(review, { verdict: "fail", outputText: "missing tests" }),
      ])
    ).actions[0] as ProtocolAction;
    expect(repair.actorRef).toBe("repairer");
    expect(repair.payload?.["context"]).toContain("solver output");
    expect(repair.payload?.["context"]).toContain("missing tests");
  });

  it("fails after maxIterations rejected reviews, treating a missing verdict as a rejection", async () => {
    const outcomes: ProtocolActionOutcome[] = [];
    for (let index = 0; index < 4; index += 1) {
      const planned = (await reduce(plugin, compiled, outcomes)).actions[0] as ProtocolAction;
      outcomes.push(outcome(planned));
    }
    const final = await reduce(plugin, compiled, outcomes);
    expect(final.state.status).toBe("failed");
    expect(final.summary.notes?.[0]).toContain("2 iteration");
  });

  it("falls back to the solver for repairs and validates required roles", async () => {
    const noRepairer = compile({
      id: "h.verifier.min",
      protocol: "verifier-loop",
      agents: [
        { id: "s", role: "solver" },
        { id: "c", role: "critic" },
      ],
    });
    expect(await plugin.validate?.(noRepairer)).toEqual([]);
    const solve = (await reduce(plugin, noRepairer, [])).actions[0] as ProtocolAction;
    const review = (await reduce(plugin, noRepairer, [outcome(solve)]))
      .actions[0] as ProtocolAction;
    const repair = (
      await reduce(plugin, noRepairer, [outcome(solve), outcome(review, { verdict: "fail" })])
    ).actions[0];
    expect(repair?.actorRef).toBe("s");

    const missingCritic = compile({
      id: "h.verifier.bad",
      protocol: "verifier-loop",
      agents: [{ id: "s", role: "solver" }],
    });
    expect((await plugin.validate?.(missingCritic))?.[0]?.code).toBe("missing_protocol_actor");
  });
});

describe("hierarchy protocol", () => {
  const compiled = compile({
    id: "h.hierarchy",
    protocol: "hierarchy",
    agents: [
      { id: "boss", role: "manager" },
      { id: "fe", role: "implementer" },
      { id: "be", role: "implementer" },
      { id: "qa", role: "tester" },
    ],
    relationships: [
      { id: "r1", kind: "delegates_to", fromAgentRef: "boss", toAgentRef: "fe" },
      { id: "r2", kind: "delegates_to", fromAgentRef: "boss", toAgentRef: "be" },
    ],
  });
  const plugin = createHierarchyProtocol();

  it("plans, fans out the manager's assignments in parallel, then synthesizes", async () => {
    expect(await plugin.validate?.(compiled)).toEqual([]);
    const plan = (await reduce(plugin, compiled, [])).actions[0] as ProtocolAction;
    expect(plan.actorRef).toBe("boss");
    expect(plan.payload?.["phase"]).toBe("plan");

    const planOutcome = outcome(plan, {
      data: {
        assignments: [
          { actorRef: "fe", task: "Build the form" },
          { actorRef: "qa", task: "Not a report of boss" },
          { actorRef: "be", task: "Build the API" },
        ],
      },
    });
    const fanOut = await reduce(plugin, compiled, [planOutcome]);
    expect(
      fanOut.actions.map((item) => [item.kind, item.actorRef, item.payload?.["task"]]),
    ).toEqual([
      ["delegate_work", "fe", "Build the form"],
      ["delegate_work", "be", "Build the API"],
    ]);

    const reports = fanOut.actions.map((item, index) =>
      outcome(item, index === 1 ? { status: "failed", failureMessage: "db down" } : {}),
    );
    const synth = await reduce(plugin, compiled, [planOutcome, ...reports]);
    expect(synth.actions[0]?.payload?.["phase"]).toBe("synthesize");
    expect(synth.actions[0]?.payload?.["context"]).toContain("fe output");
    expect(synth.actions[0]?.payload?.["context"]).toContain("db down");

    const done = await reduce(plugin, compiled, [
      planOutcome,
      ...reports,
      outcome(synth.actions[0] as ProtocolAction, { outputText: "final" }),
    ]);
    expect(done.state.status).toBe("done");
    expect(done.state.data?.["output"]).toBe("final");
  });

  it("delegates to every report when the plan has no structured assignments", async () => {
    const plan = (await reduce(plugin, compiled, [])).actions[0] as ProtocolAction;
    const fanOut = await reduce(plugin, compiled, [outcome(plan)]);
    expect(fanOut.actions.map((item) => item.actorRef)).toEqual(["fe", "be"]);
  });

  it("requires a manager", async () => {
    const noManager = compile({
      id: "h.hierarchy.bad",
      protocol: "hierarchy",
      agents: [{ id: "a", role: "implementer" }],
    });
    expect((await plugin.validate?.(noManager))?.[0]?.code).toBe("missing_protocol_actor");
  });
});

describe("squad protocol", () => {
  const plugin = createSquadProtocol();

  it("assigns configured work items to members in parallel batches with a shared board", async () => {
    const compiled = compile({
      id: "h.squad",
      protocol: "squad",
      agents: [
        { id: "a", role: "worker" },
        { id: "b", role: "worker" },
      ],
      config: { workItems: ["one", { id: "two", task: "second" }, "three"] },
    });
    const first = await reduce(plugin, compiled, []);
    expect(
      first.actions.map((item) => [item.kind, item.actorRef, item.payload?.["workItemId"]]),
    ).toEqual([
      ["claim_work", "a", "item-1"],
      ["claim_work", "b", "two"],
    ]);
    const firstOutcomes = first.actions.map((item) => outcome(item));
    const second = await reduce(plugin, compiled, firstOutcomes);
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]?.payload?.["workItemId"]).toBe("item-3");
    expect(second.actions[0]?.payload?.["context"]).toContain("a output");

    const done = await reduce(plugin, compiled, [
      ...firstOutcomes,
      outcome(second.actions[0] as ProtocolAction),
    ]);
    expect(done.state.status).toBe("done");
    expect(done.state.data?.["output"]).toContain("item-3");
  });

  it("lets the lead decompose the task when no work items are configured", async () => {
    const compiled = compile({
      id: "h.squad.decompose",
      protocol: "squad",
      agents: [
        { id: "a", role: "worker" },
        { id: "b", role: "worker" },
      ],
    });
    const decompose = (await reduce(plugin, compiled, [])).actions[0] as ProtocolAction;
    expect(decompose.payload?.["phase"]).toBe("decompose");
    const decomposed = outcome(decompose, {
      data: {
        workItems: [
          { id: "x", task: "do x" },
          { id: "y", task: "do y" },
        ],
      },
    });
    const claims = await reduce(plugin, compiled, [decomposed]);
    expect(claims.actions.map((item) => item.payload?.["workItemId"])).toEqual(["x", "y"]);

    const failed = await reduce(plugin, compiled, [
      decomposed,
      outcome(claims.actions[0] as ProtocolAction),
      outcome(claims.actions[1] as ProtocolAction, { status: "failed", failureMessage: "nope" }),
    ]);
    expect(failed.state.status).toBe("failed");
    expect(failed.summary.notes?.[0]).toContain("nope");
  });

  it("requires a shared space", async () => {
    const compiled = compile({
      id: "h.squad.private",
      protocol: "squad",
      agents: [{ id: "a", role: "worker" }],
      shared: false,
    });
    expect((await plugin.validate?.(compiled))?.[0]?.code).toBe("missing_shared_space");
  });
});

describe("verifier-loop protocol with a goal", () => {
  const plugin = createVerifierLoopProtocol();
  const goal = { id: "goal.fix", fingerprint: "abc" };
  const withCritic = compile({
    id: "h.verifier.goal",
    protocol: "verifier-loop",
    agents: [
      { id: "solver", role: "solver" },
      { id: "critic", role: "critic" },
    ],
  });

  async function reduceWithGoal(
    compiled: CompiledHarness,
    outcomes: readonly ProtocolActionOutcome[],
    withGoal = true,
  ) {
    return plugin.reduce({
      compiled,
      state: { status: "ready" },
      events: [],
      outcomes,
      instruction: "Fix it.",
      ...(withGoal ? { goal } : {}),
    });
  }

  it("checks the goal validators before the critic and repairs from their feedback", async () => {
    const solve = (await reduceWithGoal(withCritic, [])).actions[0] as ProtocolAction;
    const validate = (await reduceWithGoal(withCritic, [outcome(solve)]))
      .actions[0] as ProtocolAction;
    expect(validate.kind).toBe("validate_goal");
    expect(validate.actorRef).toBeUndefined();
    expect(validate.payload?.["candidateActionId"]).toBe(solve.id);

    const failedCheck = outcome(validate, {
      verdict: "fail",
      outputText: "GOAL INCOMPLETE: tests failed",
    });
    const repair = (await reduceWithGoal(withCritic, [outcome(solve), failedCheck]))
      .actions[0] as ProtocolAction;
    expect(repair.actorRef).toBe("solver");
    expect(repair.payload?.["context"]).toContain("GOAL INCOMPLETE: tests failed");
    expect(repair.payload?.["context"]).toContain("Goal check feedback");

    const repaired = outcome(repair, { outputText: "fixed" });
    const validate2 = (await reduceWithGoal(withCritic, [outcome(solve), failedCheck, repaired]))
      .actions[0] as ProtocolAction;
    const passed = outcome(validate2, { verdict: "pass" });
    const review = (
      await reduceWithGoal(withCritic, [outcome(solve), failedCheck, repaired, passed])
    ).actions[0] as ProtocolAction;
    expect(review.kind).toBe("review_artifact");
    expect(review.payload?.["context"]).toContain("fixed");

    const done = await reduceWithGoal(withCritic, [
      outcome(solve),
      failedCheck,
      repaired,
      passed,
      outcome(review, { verdict: "pass" }),
    ]);
    expect(done.state.status).toBe("done");
    expect(done.state.data?.["output"]).toBe("fixed");
    expect(done.state.data?.["acceptance"]).toBe("goal-then-critic");
  });

  it("uses only the validators when there is no critic, and needs a goal for that", async () => {
    const goalOnly = compile({
      id: "h.verifier.goal-only",
      protocol: "verifier-loop",
      agents: [{ id: "solver", role: "solver" }],
      config: { acceptance: "goal" },
    });
    expect(await plugin.validate?.(goalOnly)).toEqual([]);
    const solve = (await reduceWithGoal(goalOnly, [])).actions[0] as ProtocolAction;
    const validate = (await reduceWithGoal(goalOnly, [outcome(solve)]))
      .actions[0] as ProtocolAction;
    const done = await reduceWithGoal(goalOnly, [
      outcome(solve),
      outcome(validate, { verdict: "pass" }),
    ]);
    expect(done.state.status).toBe("done");

    const noGoal = await reduceWithGoal(goalOnly, [], false);
    expect(noGoal.state.status).toBe("blocked");
    expect(noGoal.summary.notes?.[0]).toContain("sealed goal");
  });

  it("keeps critic-only acceptance when configured even with a goal", async () => {
    const criticOnly = compile({
      id: "h.verifier.critic-only",
      protocol: "verifier-loop",
      agents: [
        { id: "solver", role: "solver" },
        { id: "critic", role: "critic" },
      ],
      config: { acceptance: "critic" },
    });
    const solve = (await reduceWithGoal(criticOnly, [])).actions[0] as ProtocolAction;
    const next = (await reduceWithGoal(criticOnly, [outcome(solve)])).actions[0];
    expect(next?.kind).toBe("review_artifact");
  });
});
