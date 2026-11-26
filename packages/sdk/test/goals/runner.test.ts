import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../src/events/taxonomy.js";
import type { AgentHarnessEventProjection } from "../../src/harness/types.js";
import {
  type GoalEvidence,
  type GoalJudge,
  type GoalSpec,
  type GoalValidatorSpec,
  GoalTamperError,
  PROTECTED_PATHS_VALIDATOR_ID,
  buildRubricJudgePrompt,
  checkAgainstJsonSchema,
  describeGoalForAgent,
  findProtectedPathViolations,
  goalTraceFromCanonicalEvents,
  goalTraceFromProjections,
  goalValidationReportJsonSchema,
  isProtectedPath,
  readJsonPath,
  runGoalValidators,
  sealGoal,
} from "../../src/goals/index.js";

function goalWith(validators: GoalValidatorSpec[], extra: Partial<GoalSpec> = {}) {
  return sealGoal({
    id: "goal-1",
    objective: "Ship the report.",
    definitionOfDone: ["The report is complete"],
    validators,
    ...extra,
  });
}

const fixedNow = () => new Date("2026-11-26T12:00:00.000Z");

describe("numeric validators", () => {
  const coverage = goalWith([
    {
      id: "coverage",
      kind: "numeric",
      source: { metric: "coverage" },
      operator: "gte",
      value: 0.8,
      unit: "ratio",
    },
  ]);

  it("passes when the metric meets the threshold", async () => {
    const report = await runGoalValidators(
      coverage,
      { metrics: { coverage: 0.9 } },
      { now: fixedNow },
    );
    expect(report.status).toBe("COMPLETE");
    expect(report.complete).toBe(true);
    expect(report.feedback).toBe("GOAL COMPLETE: goal-1. All 1 required check(s) passed.");
    expect(report.evaluatedAt).toBe("2026-11-26T12:00:00.000Z");
    expect(checkAgainstJsonSchema(goalValidationReportJsonSchema, report).valid).toBe(true);
  });

  it("fails with the observed value and a fix", async () => {
    const report = await runGoalValidators(coverage, { metrics: { coverage: 0.62 } });
    expect(report.status).toBe("INCOMPLETE");
    expect(report.results[0]).toMatchObject({
      validatorId: "coverage",
      status: "failed",
      observed: 0.62,
      message: "Metric coverage is 0.62; needs >= 0.8 ratio.",
      fix: "Change the work so metric coverage becomes >= 0.8 ratio (currently 0.62).",
    });
    expect(report.feedback).toContain(
      "GOAL INCOMPLETE: goal-1. 1 of 1 required check(s) did not pass.",
    );
    expect(report.feedback).toContain("1. [numeric] coverage failed:");
    expect(report.feedback).toContain("change the work, not the checks");
  });

  it("fails when the metric is missing", async () => {
    const report = await runGoalValidators(coverage, {});
    expect(report.results[0]).toMatchObject({
      status: "failed",
      fix: "Measure and report coverage.",
    });
  });

  it("reads numbers from structured output, including JSON in outputText", async () => {
    const goal = goalWith([
      {
        id: "total",
        kind: "numeric",
        source: { outputPath: "summary.rows[1].total" },
        operator: "between",
        min: 10,
        max: 20,
      },
      {
        id: "errors",
        kind: "numeric",
        source: { outputPath: "errors" },
        operator: "eq",
        value: 0,
        tolerance: 0.001,
      },
    ]);
    const passing = await runGoalValidators(goal, {
      outputText: '```json\n{"summary":{"rows":[{"total":1},{"total":15}]},"errors":0.0005}\n```',
    });
    expect(passing.complete).toBe(true);

    const failing = await runGoalValidators(goal, {
      output: { summary: { rows: [] }, errors: "none" },
    });
    expect(failing.results.map((result) => result.status)).toEqual(["failed", "failed"]);
    expect(failing.results[0]?.message).toContain("has no value at summary.rows[1].total");
    expect(failing.results[1]?.message).toContain('is "none", not a finite number');

    const notJson = await runGoalValidators(goal, { outputText: "I did it!" });
    expect(notJson.results[0]?.message).toBe("The final output is not valid JSON.");
  });

  it("supports every comparison operator", async () => {
    const cases: [GoalValidatorSpec, number, boolean][] = [
      [{ id: "a", kind: "numeric", source: { metric: "m" }, operator: "gt", value: 1 }, 1, false],
      [{ id: "a", kind: "numeric", source: { metric: "m" }, operator: "lt", value: 1 }, 0, true],
      [{ id: "a", kind: "numeric", source: { metric: "m" }, operator: "lte", value: 1 }, 1, true],
      [{ id: "a", kind: "numeric", source: { metric: "m" }, operator: "neq", value: 1 }, 1, false],
      [{ id: "a", kind: "numeric", source: { metric: "m" }, operator: "eq", value: 1 }, 1, true],
    ];
    for (const [validator, value, complete] of cases) {
      const report = await runGoalValidators(goalWith([validator]), { metrics: { m: value } });
      expect(report.complete).toBe(complete);
    }
  });

  it("reads JSON paths", () => {
    expect(readJsonPath({ a: [{ b: 2 }] }, "a[0].b")).toBe(2);
    expect(readJsonPath({ a: [{ b: 2 }] }, "a.0.b")).toBe(2);
    expect(readJsonPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(readJsonPath({}, "constructor")).toBeUndefined();
  });
});

describe("rubric validators", () => {
  const rubric = goalWith([
    {
      id: "quality",
      kind: "rubric",
      criteria: [
        { id: "clarity", description: "Plain, skimmable prose" },
        { id: "accuracy", description: "Numbers match the ledger", required: true, weight: 2 },
      ],
      passThreshold: 0.75,
      judgeInstructions: "Ledger total is 1200.",
    },
  ]);

  it("passes the subject, criteria, and instructions to the judge", async () => {
    const judge = vi.fn<GoalJudge>(() => ({
      criteria: [
        { criterionId: "clarity", score: 0.7 },
        { criterionId: "accuracy", score: 1 },
      ],
      summary: "Solid.",
    }));
    const report = await runGoalValidators(
      rubric,
      { outputText: "Total: 1200" },
      { judges: judge },
    );
    expect(report.complete).toBe(true);
    expect(report.results[0]?.score).toBeCloseTo(0.9);
    const request = judge.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      goalId: "goal-1",
      validatorId: "quality",
      subject: "Total: 1200",
      instructions: "Ledger total is 1200.",
      objective: "Ship the report.",
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails when a required criterion misses even if the weighted score passes", async () => {
    const report = await runGoalValidators(
      rubric,
      { outputText: "Total: 1100" },
      {
        judges: {
          default: () => ({
            criteria: [
              { criterionId: "clarity", score: 1 },
              {
                criterionId: "accuracy",
                score: 0.7,
                rationale: "Total is off by 100.",
                improvement: "Use 1200.",
              },
            ],
          }),
        },
      },
    );
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.score).toBeCloseTo(0.8);
    expect(report.results[0]?.message).toContain(
      "accuracy scored 0.70 (needs 0.75, required): Total is off by 100.",
    );
    expect(report.results[0]?.fix).toBe("Improve the final output: accuracy: Use 1200..");
  });

  it("accepts judge output as a JSON string and rejects malformed or partial judgments", async () => {
    const asString = await runGoalValidators(
      rubric,
      { outputText: "x" },
      {
        judges: () =>
          '{"criteria":[{"criterionId":"clarity","score":0.9},{"criterionId":"accuracy","score":0.9}]}' as never,
      },
    );
    expect(asString.complete).toBe(true);

    const partial = await runGoalValidators(
      rubric,
      { outputText: "x" },
      { judges: () => ({ criteria: [{ criterionId: "clarity", score: 1 }] }) },
    );
    expect(partial.results[0]).toMatchObject({
      status: "error",
      message: "Judge default did not score criteria: accuracy.",
    });

    const malformed = await runGoalValidators(
      rubric,
      { outputText: "x" },
      { judges: () => ({ criteria: [{ criterionId: "clarity", score: 2 }] }) },
    );
    expect(malformed.results[0]?.status).toBe("error");
    expect(malformed.complete).toBe(false);
  });

  it("reports an error when no judge is registered or the judge times out", async () => {
    const missing = await runGoalValidators(rubric, { outputText: "x" });
    expect(missing.results[0]?.status).toBe("error");
    expect(missing.feedback).toContain("could not run");

    const slow = await runGoalValidators(
      rubric,
      { outputText: "x" },
      { judges: () => new Promise(() => undefined), defaultTimeoutMs: 20 },
    );
    expect(slow.results[0]?.message).toContain("timed out after 20 ms");
  });

  it("fails without calling the judge when there is nothing to grade", async () => {
    const judge = vi.fn<GoalJudge>();
    const report = await runGoalValidators(rubric, {}, { judges: judge });
    expect(report.results[0]?.status).toBe("failed");
    expect(judge).not.toHaveBeenCalled();
  });

  it("grades named artifacts", async () => {
    const goal = goalWith([
      {
        id: "memo",
        kind: "rubric",
        target: "artifact:memo",
        criteria: [{ id: "c", description: "Clear" }],
      },
    ]);
    const judge = vi.fn<GoalJudge>(() => ({ criteria: [{ criterionId: "c", score: 1 }] }));
    await runGoalValidators(goal, { artifacts: { memo: "The memo." } }, { judges: judge });
    expect(judge.mock.calls[0]?.[0].subject).toBe("The memo.");
  });

  it("builds a judge prompt that carries the structured-output schema", () => {
    const prompt = buildRubricJudgePrompt({
      goalId: "g",
      validatorId: "v",
      objective: "Do it.",
      definitionOfDone: ["Done"],
      criteria: [{ id: "c", description: "Clear", required: true }],
      subject: "work",
    });
    expect(prompt).toContain("- c (required): Clear");
    expect(prompt).toContain('"criterionId"');
    expect(prompt).toContain("<<<WORK\nwork\nWORK>>>");
  });
});

describe("trace validators", () => {
  const trace: GoalEvidence["trace"] = [
    { sequence: 1, type: "tool.call.started", toolName: "read_file", args: { path: "ledger.csv" } },
    {
      sequence: 2,
      type: "tool.call.completed",
      toolName: "read_file",
      args: { path: "ledger.csv" },
    },
    { sequence: 3, type: "handoff.completed", roleId: "verifier" },
    {
      sequence: 4,
      type: "tool.call.completed",
      toolName: "web_search",
      args: { query: "fx rates", opts: { n: 3 } },
    },
    {
      sequence: 5,
      type: "terminal.command.failed",
      toolName: "bash",
      args: { command: "npm test" },
      isError: true,
    },
  ];

  it("passes when every required action appears", async () => {
    const goal = goalWith([
      {
        id: "actions",
        kind: "trace",
        require: [
          { tool: "read_file", argsInclude: { path: "ledger.csv" } },
          { event: "handoff.completed", role: "verifier" },
          { tool: "web_search", argsInclude: { opts: { n: 3 } } },
          { tool: "bash", status: "failed" },
        ],
      },
    ]);
    const report = await runGoalValidators(goal, { trace });
    expect(report.complete).toBe(true);
  });

  it("names missing and forbidden actions", async () => {
    const goal = goalWith([
      {
        id: "actions",
        kind: "trace",
        require: [
          { tool: "write_file", description: "write the report file" },
          { tool: "read_file", minCount: 2 },
        ],
        forbid: [{ tool: "web_search" }],
      },
    ]);
    const report = await runGoalValidators(goal, { trace });
    expect(report.results[0]?.message).toBe(
      "Trace check failed: missing write the report file; missing tool read_file (1 of 2); forbidden action tool web_search happened 1 time(s).",
    );
    expect(report.results[0]?.fix).toBe(
      "Do write the report file; do tool read_file; do not tool web_search.",
    );
  });

  it("enforces order and max counts", async () => {
    const ordered = goalWith([
      {
        id: "order",
        kind: "trace",
        ordered: true,
        require: [{ event: "handoff.completed" }, { tool: "read_file" }],
      },
    ]);
    expect((await runGoalValidators(ordered, { trace })).complete).toBe(false);

    const inOrder = goalWith([
      {
        id: "order",
        kind: "trace",
        ordered: true,
        require: [{ tool: "read_file" }, { event: "handoff.completed" }],
      },
    ]);
    expect((await runGoalValidators(inOrder, { trace })).complete).toBe(true);

    const capped = goalWith([
      { id: "cap", kind: "trace", require: [{ tool: "read_file", status: "any", maxCount: 1 }] },
    ]);
    expect((await runGoalValidators(capped, { trace })).results[0]?.message).toContain(
      "happened 2 times (at most 1)",
    );
  });

  it("normalizes harness projections and canonical events", () => {
    const projections: AgentHarnessEventProjection[] = [
      {
        id: "e1",
        sequence: 1,
        type: "tool.call.completed",
        eventName: "plugin.runtime.event",
        occurredAt: "2026-11-26T00:00:00.000Z",
        toolName: "read_file",
        roleId: "builder",
        summary: "",
        data: { args: { path: "a.ts" } },
      },
    ];
    expect(goalTraceFromProjections(projections)).toEqual([
      {
        sequence: 1,
        type: "tool.call.completed",
        toolName: "read_file",
        roleId: "builder",
        args: { path: "a.ts" },
        isError: false,
        eventId: "e1",
      },
    ]);

    const base = {
      scopeId: "s",
      runId: "r",
      rootSessionId: "root",
      sessionId: "session",
      occurredAt: "2026-11-26T00:00:00.000Z",
      origin: { namespace: "core" as const },
    };
    const events = [
      {
        ...base,
        eventId: "c1",
        sequence: 1,
        name: "plugin.runtime.event",
        data: { type: "tool_execution_start", toolName: "bash", args: '{"command":"ls"}' },
      },
      {
        ...base,
        eventId: "c2",
        sequence: 2,
        name: "plugin.runtime.event",
        data: { type: "tool_execution_end", toolName: "edit", isError: true, input: { path: "x" } },
      },
      {
        ...base,
        eventId: "c3",
        sequence: 3,
        name: "delegation.completed",
        data: { roleId: "verifier" },
      },
    ] as unknown as CanonicalEvent[];
    expect(
      goalTraceFromCanonicalEvents(events).map((entry) => [
        entry.type,
        entry.toolName,
        entry.args,
        entry.roleId,
      ]),
    ).toEqual([
      ["terminal.command.started", "bash", { command: "ls" }, undefined],
      ["tool.call.failed", "edit", { path: "x" }, undefined],
      ["delegation.completed", undefined, undefined, "verifier"],
    ]);
  });
});

describe("output schema validators", () => {
  const goal = goalWith([
    {
      id: "shape",
      kind: "output_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["total", "regions"],
        properties: { total: { type: "number" }, regions: { type: "array", minItems: 4 } },
      },
    },
  ]);

  it("passes structured output that matches", async () => {
    const report = await runGoalValidators(goal, { output: { total: 1, regions: [1, 2, 3, 4] } });
    expect(report.complete).toBe(true);
  });

  it("lists every mismatch by path", async () => {
    const report = await runGoalValidators(goal, {
      outputText: '{"total":"1","regions":[1],"note":"hi"}',
    });
    expect(report.results[0]?.message).toBe(
      'The final output does not match the required schema: $.total: expected number, got string "1"; $.regions: must have at least 4 item(s), got 1; $.note: is not an allowed property (allowed: regions, total).',
    );
  });

  it("fails when an artifact is missing", async () => {
    const artifactGoal = goalWith([
      { id: "plan", kind: "output_schema", target: "artifact:plan", schema: { type: "object" } },
    ]);
    const report = await runGoalValidators(artifactGoal, { artifacts: {} });
    expect(report.results[0]).toMatchObject({
      status: "failed",
      message: "No artifact plan was produced, so this check had nothing to inspect.",
    });
  });
});

describe("host checks", () => {
  const goal = goalWith([
    {
      id: "tests",
      kind: "check",
      checkRef: "npm-test",
      config: { script: "test" },
      fixHint: "Run npm test locally.",
    },
  ]);

  it("calls the registered check with its config and the evidence", async () => {
    const check = vi.fn(() => ({
      passed: false,
      message: "3 tests failed.",
      fix: "Fix parser.test.ts.",
      score: 1.5,
    }));
    const evidence: GoalEvidence = { outputText: "done" };
    const report = await runGoalValidators(goal, evidence, { checks: { "npm-test": check } });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: "goal-1",
        validatorId: "tests",
        config: { script: "test" },
        evidence,
      }),
    );
    expect(report.results[0]).toMatchObject({
      status: "failed",
      message: "3 tests failed.",
      fix: "Fix parser.test.ts. Run npm test locally.",
      score: 1,
    });
  });

  it("turns a missing, throwing, or malformed check into an error", async () => {
    expect((await runGoalValidators(goal, {})).results[0]?.status).toBe("error");
    const throwing = await runGoalValidators(
      goal,
      {},
      {
        checks: {
          "npm-test": () => {
            throw new Error("spawn failed");
          },
        },
      },
    );
    expect(throwing.results[0]).toMatchObject({
      status: "error",
      message: "Validator could not run: spawn failed",
    });
    const malformed = await runGoalValidators(
      goal,
      {},
      { checks: { "npm-test": () => ({}) as never } },
    );
    expect(malformed.results[0]?.status).toBe("error");
  });

  it("honours cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await runGoalValidators(
      goal,
      {},
      {
        signal: controller.signal,
        checks: { "npm-test": () => ({ passed: true }) },
      },
    );
    expect(report.results[0]?.message).toContain("cancelled");
  });
});

describe("completion and integrity", () => {
  it("does not block on advisory validators", async () => {
    const goal = goalWith([
      { id: "must", kind: "numeric", source: { metric: "m" }, operator: "gte", value: 1 },
      {
        id: "nice",
        kind: "numeric",
        source: { metric: "n" },
        operator: "gte",
        value: 1,
        required: false,
      },
    ]);
    const report = await runGoalValidators(goal, { metrics: { m: 1, n: 0 } });
    expect(report.complete).toBe(true);
    expect(report.summary).toEqual({
      required: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      advisoryFailed: 1,
    });
    expect(report.feedback).toContain("Advisory checks that did not pass (not blocking):");
  });

  it("fails the goal when the agent writes to protected validator paths", async () => {
    const goal = goalWith(
      [{ id: "m", kind: "numeric", source: { metric: "m" }, operator: "gte", value: 1 }],
      {
        protectedPaths: ["validators/", "fixtures/expected.json"],
      },
    );
    const report = await runGoalValidators(goal, {
      metrics: { m: 1 },
      trace: [
        {
          type: "tool.call.completed",
          toolName: "read_file",
          args: { path: "validators/check.sh" },
        },
        {
          type: "tool.call.started",
          toolName: "write_file",
          args: { path: "./validators/check.sh" },
        },
        {
          type: "tool.call.completed",
          toolName: "write_file",
          args: { path: "./validators/check.sh" },
        },
        {
          type: "terminal.command.completed",
          toolName: "bash",
          args: { command: "echo '{}' > fixtures/expected.json" },
        },
        {
          type: "terminal.command.completed",
          toolName: "bash",
          args: { command: "cat fixtures/expected.json" },
        },
      ],
    });
    expect(report.complete).toBe(false);
    const integrity = report.results.find(
      (result) => result.validatorId === PROTECTED_PATHS_VALIDATOR_ID,
    );
    expect(integrity?.message).toBe(
      "The run tried to change protected validator files: ./validators/check.sh via write_file, fixtures/expected.json via bash. Validators are fixed by the goal owner and cannot be edited.",
    );
    expect(report.feedback).toContain(
      "Do not modify protected paths: validators/, fixtures/expected.json.",
    );
  });

  it("matches protected paths by exact file or directory prefix", () => {
    expect(isProtectedPath("/repo/validators/a.sh", ["validators/"])).toBe(true);
    expect(isProtectedPath("validators", ["validators/"])).toBe(true);
    expect(isProtectedPath("my-validators/a.sh", ["validators/"])).toBe(false);
    expect(isProtectedPath("src/expected.json", ["fixtures/expected.json"])).toBe(false);
    expect(
      findProtectedPathViolations(
        [{ type: "tool.call.completed", toolName: "edit", args: { paths: ["a", "validators/x"] } }],
        ["validators/"],
      ),
    ).toHaveLength(1);
  });

  it("refuses goals that were not sealed", async () => {
    const sealed = goalWith([
      { id: "m", kind: "numeric", source: { metric: "m" }, operator: "gte", value: 1 },
    ]);
    const lookalike = { ...sealed };
    await expect(runGoalValidators(lookalike, { metrics: { m: 1 } })).rejects.toThrow(
      GoalTamperError,
    );
    await expect(
      runGoalValidators(sealed, { metrics: { m: 1 } }, { expectedFingerprint: "nope" }),
    ).rejects.toThrow(GoalTamperError);
  });

  it("describes the goal and its checks for the agent prompt", () => {
    const goal = goalWith(
      [
        {
          id: "coverage",
          kind: "numeric",
          source: { metric: "coverage" },
          operator: "gte",
          value: 0.8,
        },
        {
          id: "read",
          kind: "trace",
          ordered: true,
          require: [{ tool: "read_file" }],
          forbid: [{ tool: "rm" }],
        },
        { id: "q", kind: "rubric", required: false, criteria: [{ id: "c", description: "Clear" }] },
        { id: "shape", kind: "output_schema", schema: { type: "object" } },
        { id: "tests", kind: "check", checkRef: "npm-test", description: "Unit tests pass" },
      ],
      { title: "Report", protectedPaths: ["validators/"] },
    );
    expect(describeGoalForAgent(goal)).toBe(
      [
        "Goal goal-1: Report",
        "Objective: Ship the report.",
        "Definition of done:",
        "- The report is complete",
        "Checks that decide completion:",
        "- coverage (metric coverage >= 0.8)",
        "- read (must in order do: tool read_file; must not: tool rm)",
        "- q (advisory) (rubric on the final output: Clear)",
        '- shape (the final output must be JSON matching {"type":"object"})',
        "- tests: Unit tests pass (host check npm-test)",
        "Protected paths you must not modify: validators/.",
        "You are done only when every required check passes.",
      ].join("\n"),
    );
  });
});
