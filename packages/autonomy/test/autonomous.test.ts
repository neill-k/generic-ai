// Adapted from the tests in Prime Agent's `autonomous/mod.rs`, `autonomous/driver.rs` and
// `autonomous/gates.rs` (PrimeIntellect-ai/prime-agent). Copyright (c) 2025-2026 Prime Intellect Ltd.
// MIT License.

import { describe, expect, it } from "vitest";

import {
  AutonomousDriver,
  autonomousContinuationText,
  autonomousLimitReason,
  autonomousStatus,
  autonomousTokenDelta,
  addAutonomousUsage,
  createAutonomousRuntimeState,
  DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
  describeAutonomousLimit,
  type GateCommandResult,
  type GateRunner,
  isUnlimitedAutonomousLimit,
  setAutonomousEnabled,
  setAutonomousLimits,
  shouldAutonomouslyContinue,
  truncateGateOutput,
  UNLIMITED_AUTONOMOUS_LIMIT,
  type WorktreeSnapshot,
} from "../src/index.js";
import { turn, usage } from "./helpers.js";

const ok: GateCommandResult = {
  status: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};
const fail: GateCommandResult = {
  status: 1,
  stdout: "1 test failed",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};

class ScriptedRunner implements GateRunner {
  readonly runs: string[] = [];
  snapshot: WorktreeSnapshot | undefined;
  constructor(private readonly results: GateCommandResult[]) {}
  async runGate(command: string): Promise<GateCommandResult> {
    this.runs.push(command);
    return this.results.length > 1
      ? (this.results.shift() as GateCommandResult)
      : (this.results[0] as GateCommandResult);
  }
  async captureSnapshot(): Promise<WorktreeSnapshot | undefined> {
    return this.snapshot;
  }
}

describe("autonomous state", () => {
  it("applies defaults and overrides", () => {
    const off = createAutonomousRuntimeState();
    expect(off.enabled).toBe(false);
    expect(off.limits).toEqual({
      maxContinuations: 3,
      maxTurns: 12,
      maxTokens: 80_000,
      timeoutMs: 30 * 60 * 1000,
    });
    expect(off.continuationPrompt).toBe(DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT);
    expect(off.gates).toEqual({ commands: [], maxRetries: 3, timeoutMs: 5 * 60 * 1000 });
    const on = createAutonomousRuntimeState(
      {
        enabled: true,
        maxTurns: 5,
        maxTokens: 0,
        continuationPrompt: "  keep going  ",
        gates: { commands: ["npm test"], maxRetries: 1 },
      },
      { maxContinuations: 7 },
      42,
    );
    expect(on.enabled).toBe(true);
    expect(on.startedAt).toBe(42);
    expect(on.limits.maxContinuations).toBe(7);
    expect(on.limits.maxTurns).toBe(5);
    expect(on.limits.maxTokens).toBe(80_000);
    expect(on.continuationPrompt).toBe("keep going");
    expect(on.gates.commands).toEqual(["npm test"]);
    expect(on.gates.maxRetries).toBe(1);
  });

  it("resets on enable and clears on disable", () => {
    const state = createAutonomousRuntimeState({ enabled: true }, {}, 1);
    state.turnsUsed = 4;
    state.gateAttempts.set("x", 2);
    setAutonomousEnabled(state, true, 9);
    expect(state.turnsUsed).toBe(0);
    expect(state.startedAt).toBe(9);
    expect(state.gateAttempts.size).toBe(0);
    setAutonomousEnabled(state, false);
    expect(state.startedAt).toBeUndefined();
    setAutonomousLimits(state, { maxTurns: 2, gates: { commands: ["a"] } });
    expect(state.limits.maxTurns).toBe(2);
    expect(state.gates.commands).toEqual(["a"]);
  });

  it("counts cache writes but not cache reads", () => {
    expect(autonomousTokenDelta(usage(10, 5, 3, 100))).toBe(18);
    const state = createAutonomousRuntimeState({ enabled: true });
    addAutonomousUsage(state, usage(10, 5, 3, 100));
    expect(state.turnsUsed).toBe(1);
    expect(state.tokensUsed).toBe(18);
    const off = createAutonomousRuntimeState();
    addAutonomousUsage(off, usage(10, 5));
    expect(off.turnsUsed).toBe(0);
  });

  it("checks limits in order", () => {
    const state = createAutonomousRuntimeState({ enabled: true, timeoutMs: 100 }, {}, 0);
    expect(autonomousLimitReason(state, 50)).toBeUndefined();
    expect(autonomousLimitReason(state, 100)).toBe("timeoutMs");
    state.tokensUsed = 80_000;
    expect(autonomousLimitReason(state, 0)).toBe("maxTokens");
    state.turnsUsed = 12;
    expect(autonomousLimitReason(state, 0)).toBe("maxTurns");
    state.continuationsUsed = 3;
    expect(autonomousLimitReason(state, 0)).toBe("maxContinuations");
    const status = autonomousStatus(state);
    expect(describeAutonomousLimit(status, "maxTurns")).toBe("maxTurns reached (12/12)");
    expect(describeAutonomousLimit(status, "timeoutMs", 250)).toBe("timeoutMs reached (250/100)");
  });

  it("builds continuation texts and knows the unlimited sentinel", () => {
    const state = createAutonomousRuntimeState({ enabled: true });
    expect(autonomousContinuationText(state)).toBe(
      `[autonomous-continuation]\n\n${DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT}`,
    );
    expect(isUnlimitedAutonomousLimit(UNLIMITED_AUTONOMOUS_LIMIT)).toBe(true);
    expect(isUnlimitedAutonomousLimit(1_000)).toBe(false);
  });

  it("truncates long gate output", () => {
    expect(truncateGateOutput("short", false)).toBe("short");
    expect(truncateGateOutput("short", true)).toBe("short\n... [truncated]");
    expect(truncateGateOutput("x".repeat(7000), false)).toHaveLength(
      6000 + "\n... [truncated]".length,
    );
  });
});

describe("autonomous decisions", () => {
  it("continues without gates until a limit", async () => {
    const state = createAutonomousRuntimeState({ enabled: true, maxTurns: 2 });
    const runner = new ScriptedRunner([ok]);
    expect(await shouldAutonomouslyContinue(state, "stop", runner)).toEqual({
      shouldContinue: true,
      reason: "missing-terminal-evidence",
    });
    state.turnsUsed = 2;
    expect(await shouldAutonomouslyContinue(state, "stop", runner)).toEqual({
      shouldContinue: false,
      reason: "limit-reached",
    });
    expect(await shouldAutonomouslyContinue(state, "error", runner)).toEqual({
      shouldContinue: false,
      reason: "not-needed",
    });
    expect(runner.runs).toEqual([]);
  });

  it("stops when the gates pass and feeds back a failed gate", async () => {
    const driver = new AutonomousDriver(
      createAutonomousRuntimeState({ enabled: true, gates: { commands: ["npm test"] } }),
      new ScriptedRunner([fail, ok]),
      () => Date.UTC(2026, 10, 26),
    );
    const first = await driver.afterTurn(turn(1, { text: "done" }));
    expect(first).toEqual({
      kind: "continue",
      text: "[autonomous-continuation: gate-failed]\n\nAutonomous quality gate failed (attempt 1/3): `npm test` exited with code 1.\n\nOutput:\n1 test failed\n\n\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: 2026-11-26T00:00:00.000Z.",
    });
    expect(driver.state.continuationsUsed).toBe(1);
    const second = await driver.afterTurn(turn(2, { text: "fixed" }));
    expect(second.kind).toBe("stop");
    expect(second.kind === "stop" && second.reason).toEqual({ kind: "gate-passed" });
  });

  it("stops after the gate retries run out", async () => {
    const driver = new AutonomousDriver(
      createAutonomousRuntimeState({
        enabled: true,
        maxContinuations: 10,
        gates: { commands: ["npm test"], maxRetries: 1 },
      }),
      new ScriptedRunner([fail]),
    );
    expect((await driver.afterTurn(turn(1))).kind).toBe("continue");
    const stop = await driver.afterTurn(turn(2));
    expect(stop.kind === "stop" && stop.reason).toEqual({ kind: "gate-retry-exhausted" });
  });

  it("reports the limit that stopped the run", async () => {
    const driver = new AutonomousDriver(
      createAutonomousRuntimeState({ enabled: true, maxTurns: 1 }),
      new ScriptedRunner([ok]),
    );
    driver.accountMessage(turn(1, { usage: usage(5, 5) }));
    driver.accountMessage(turn(2, { stopReason: "error" }));
    expect(driver.state.turnsUsed).toBe(1);
    const stop = await driver.afterTurn(turn(1));
    expect(stop.kind === "stop" && stop.reason).toEqual({ kind: "limit", limit: "maxTurns" });
    expect(stop.kind === "stop" && stop.status.tokensUsed).toBe(10);
    expect((await driver.afterTurn(turn(3, { stopReason: "aborted" }))).kind).toBe("inactive");
  });

  it("does not rerun a failed gate on an unchanged workspace", async () => {
    const runner = new ScriptedRunner([fail]);
    runner.snapshot = { status: "M a.ts", diff: "d", untrackedHash: "h" };
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 10,
      gates: { commands: ["npm test"] },
    });
    await shouldAutonomouslyContinue(state, "stop", runner);
    await shouldAutonomouslyContinue(state, "stop", runner);
    expect(runner.runs).toEqual(["npm test"]);
    expect(state.lastGateFailure?.attempt).toBe(2);
    expect(state.lastGateFailure?.exitText).toBe(
      "not rerun: workspace unchanged since previous failed gate",
    );
    runner.snapshot = { status: "M a.ts", diff: "d2", untrackedHash: "h" };
    await shouldAutonomouslyContinue(state, "stop", runner);
    expect(runner.runs).toEqual(["npm test", "npm test"]);
  });
});
