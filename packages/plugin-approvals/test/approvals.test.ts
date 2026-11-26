import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSqliteRunStore } from "@generic-ai/plugin-storage-sqlite";
import {
  type ApprovalServiceContract,
  type ApprovalServiceEvent,
  type AuthContext,
  DEFAULT_APPROVAL_POLICY,
  createMemoryToolEffectJournal,
  createToolEffectGuard,
  evaluateApprovalPolicy,
  getAgentHarnessToolEffects,
  isApprovalError,
  parseApprovalPolicy,
  type RunActor,
  type RunStoreContract,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { createManualClock, type ManualClock } from "@generic-ai/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalWaitTimeoutError,
  createApprovalGate,
  createApprovalRoutes,
  createApprovalService,
  createTopologyApprover,
} from "../src/index.js";

const OWNER: RunActor = {
  subjectId: "owner",
  actorType: "human",
  credentialSource: "passkey",
  displayName: "Neill",
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function openStore(clock: ManualClock): RunStoreContract {
  const directory = mkdtempSync(path.join(tmpdir(), "gai-approvals-"));
  const store = createSqliteRunStore({ path: path.join(directory, "state.db"), now: clock.now });
  cleanups.push(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function openService(clock = createManualClock()) {
  const runStore = openStore(clock);
  const service = createApprovalService({ runStore, now: () => new Date(clock.now()) });
  return { clock, runStore, service };
}

interface FakeTool {
  readonly name: string;
  readonly calls: unknown[];
  execute(toolCallId: string, params: unknown): Promise<unknown>;
}

function fakeTool(name: string, effects: readonly string[]): FakeTool {
  const calls: unknown[] = [];
  const tool = {
    name,
    calls,
    async execute(_toolCallId: string, params: unknown) {
      calls.push(params);
      return { content: [{ type: "text", text: `${name} done` }], details: {} };
    },
  };
  return withAgentHarnessToolEffects(tool, {
    id: name,
    effects: effects as never,
    reversibility: "irreversible",
  });
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;
}

const EMAIL = { to: "alice@example.com", subject: "Quarterly update", body: "Numbers attached." };

describe("approval policy", () => {
  it("requires approval for outward effects by default and allows the rest", () => {
    expect(
      evaluateApprovalPolicy(DEFAULT_APPROVAL_POLICY, {
        toolName: "gmail_send",
        effects: ["mcp.write", "message.send"],
      }),
    ).toMatchObject({ decision: "require_approval", ruleId: "outward-actions" });
    expect(
      evaluateApprovalPolicy(DEFAULT_APPROVAL_POLICY, { toolName: "read", effects: ["fs.read"] })
        .decision,
    ).toBe("allow");
  });

  it("applies the first matching rule with tool globs, agents and reversibility", () => {
    const policy = parseApprovalPolicy({
      rules: [
        { id: "ops-can-schedule", decision: "allow", tools: ["calendar_*"], agents: ["vp-ops"] },
        { id: "no-payments", decision: "deny", effects: ["payment.spend"] },
        {
          id: "irreversible",
          decision: "require_approval",
          reversibility: ["irreversible"],
          ttlMs: 1000,
        },
      ],
      defaultDecision: "allow",
    });
    expect(
      evaluateApprovalPolicy(policy, {
        toolName: "calendar_create",
        effects: ["external.write"],
        agentId: "vp-ops",
        reversibility: "irreversible",
      }).ruleId,
    ).toBe("ops-can-schedule");
    expect(
      evaluateApprovalPolicy(policy, { toolName: "stripe_charge", effects: ["payment.spend"] })
        .decision,
    ).toBe("deny");
    expect(
      evaluateApprovalPolicy(policy, {
        toolName: "calendar_create",
        effects: ["external.write"],
        agentId: "analyst",
        reversibility: "irreversible",
      }),
    ).toMatchObject({ decision: "require_approval", ttlMs: 1000 });
  });

  it("rejects malformed policies with the field name", () => {
    expect(() => parseApprovalPolicy({ rules: [{ id: "x", decision: "maybe" }] })).toThrow(
      /rules\[0\]\.decision/,
    );
    expect(() =>
      parseApprovalPolicy({
        rules: [
          { id: "x", decision: "allow" },
          { id: "x", decision: "deny" },
        ],
      }),
    ).toThrow(/more than one rule/);
  });
});

describe("approval service", () => {
  it("stores requests durably, decides once, and records who decided", async () => {
    const { service, runStore, clock } = openService();
    const events: ApprovalServiceEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });
    const request = await service.request({
      approvalId: "apr-1",
      requester: { agentId: "vp-ops", taskId: "task-1", rootTaskId: "task-1" },
      action: {
        kind: "tool.call",
        name: "gmail_send",
        input: EMAIL,
        effects: ["message.send"],
        summary: "Email alice@example.com",
      },
      policy: { ruleId: "outward-actions", reason: "Outward." },
    });
    expect(request.status).toBe("pending");
    expect(request.action.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(request.expiresAt ?? "")).toBe(clock.now() + 72 * 60 * 60 * 1000);

    // Idempotent on id.
    const again = await service.request({
      approvalId: "apr-1",
      requester: request.requester,
      action: request.action,
      policy: request.policy,
    });
    expect(again.version).toBe(request.version);

    // Two concurrent decisions: exactly one wins.
    const results = await Promise.allSettled([
      service.decide({ approvalId: "apr-1", decision: "approved", actor: OWNER, comment: "ok" }),
      service.decide({ approvalId: "apr-1", decision: "rejected", actor: OWNER }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(isApprovalError((failure as PromiseRejectedResult).reason, "ALREADY_DECIDED")).toBe(
      true,
    );

    const decided = await service.get("apr-1");
    expect(decided?.decision?.decidedBy.subjectId).toBe("owner");

    // A fresh service over the same store sees the same state (restart).
    const reopened = createApprovalService({ runStore });
    expect((await reopened.get("apr-1"))?.status).toBe(decided?.status);

    const history = await service.history("apr-1");
    expect(history.map((event) => event.name)).toEqual([
      "approval.requested",
      decided?.status === "approved" ? "approval.approved" : "approval.rejected",
    ]);
    expect(history[1]?.actor?.subjectId).toBe("owner");
    expect(events.map((event) => event.type)).toContain("approval.requested");
  });

  it("claims an approved action for execution exactly once", async () => {
    const { service } = openService();
    await service.request({
      approvalId: "apr-2",
      requester: { agentId: "ceo" },
      action: { kind: "custom", name: "wire", input: { usd: 10 }, effects: [], summary: "Pay $10" },
      policy: { reason: "Money." },
    });
    await expect(service.claimExecution("apr-2")).rejects.toMatchObject({ code: "NOT_APPROVED" });
    await service.decide({ approvalId: "apr-2", decision: "approved", actor: OWNER });
    const claims = await Promise.allSettled([
      service.claimExecution("apr-2"),
      service.claimExecution("apr-2"),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    const done = await service.completeExecution({
      approvalId: "apr-2",
      state: "succeeded",
      resultSummary: "Paid",
    });
    expect(done.execution).toMatchObject({ state: "succeeded", resultSummary: "Paid" });
    expect((await service.history("apr-2")).at(-1)?.name).toBe("approval.executed");
  });

  it("expires undecided requests and lists by status and task", async () => {
    const { service, clock } = openService();
    for (const [id, taskId] of [
      ["apr-a", "t1"],
      ["apr-b", "t2"],
    ] as const) {
      await service.request({
        approvalId: id,
        requester: { agentId: "ceo", taskId },
        action: { kind: "custom", name: "post", effects: [], summary: id },
        policy: { reason: "r" },
        ttlMs: 1000,
      });
    }
    expect((await service.list({ status: "pending" })).map((a) => a.approvalId).sort()).toEqual([
      "apr-a",
      "apr-b",
    ]);
    expect((await service.list({ taskId: "t2" })).map((a) => a.approvalId)).toEqual(["apr-b"]);

    clock.advance(1001);
    await expect(
      service.decide({ approvalId: "apr-a", decision: "approved", actor: OWNER }),
    ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect(await service.expireDue()).toBe(1);
    expect((await service.list({ status: "expired" })).map((a) => a.approvalId).sort()).toEqual([
      "apr-a",
      "apr-b",
    ]);
    expect(await service.list({ status: "pending" })).toEqual([]);
    expect(await service.cancel("apr-a")).toBeUndefined();
  });
});

describe("approval gate", () => {
  function gateFor(service: ApprovalServiceContract, mode: "suspend" | "wait" = "suspend") {
    return createApprovalGate({
      service,
      requester: { agentId: "vp-ops", role: "vp", taskId: "task-9", runId: "run-1" },
      mode,
      pollIntervalMs: 5,
      waitTimeoutMs: 2_000,
    });
  }

  it("lets allowed tools through untouched", async () => {
    const { service } = openService();
    const read = fakeTool("read", ["fs.read"]);
    const wrapped = gateFor(service).wrapTool(read);
    expect(getAgentHarnessToolEffects(wrapped)).toEqual(["fs.read"]);
    expect(text(await wrapped.execute("c1", { path: "a" }))).toBe("read done");
    expect(await service.list()).toEqual([]);
  });

  it("suspends an outward call, then runs the approved call exactly once", async () => {
    const { service } = openService();
    const send = fakeTool("gmail_send", ["mcp.write", "message.send"]);
    const gate = gateFor(service);
    const wrapped = gate.wrapTool(send);

    const first = await wrapped.execute("c1", EMAIL);
    expect(text(first)).toContain("needs the owner's approval");
    expect(send.calls).toHaveLength(0);
    const [pending] = gate.pending();
    expect(pending?.action).toMatchObject({ name: "gmail_send", input: EMAIL });
    expect(pending?.requester).toMatchObject({ agentId: "vp-ops", taskId: "task-9" });

    await service.decide({
      approvalId: pending?.approvalId ?? "",
      decision: "approved",
      actor: OWNER,
    });

    // A later turn of the same task repeats the call with the same input (keys reordered).
    const nextTurn = createApprovalGate({
      service,
      requester: { agentId: "vp-ops", role: "vp", taskId: "task-9", runId: "run-2" },
    }).wrapTool(send);
    const reordered = { body: EMAIL.body, subject: EMAIL.subject, to: EMAIL.to };
    expect(text(await nextTurn.execute("c2", reordered))).toBe("gmail_send done");
    expect(send.calls).toHaveLength(1);
    expect((await service.get(pending?.approvalId ?? ""))?.execution?.state).toBe("succeeded");

    // Doing it again needs a new approval.
    expect(text(await nextTurn.execute("c3", EMAIL))).toContain("needs the owner's approval");
    expect(send.calls).toHaveLength(1);
    // A different input is a different request.
    await nextTurn.execute("c4", { ...EMAIL, to: "bob@example.com" });
    expect(await service.list({ status: "pending" })).toHaveLength(2);
  });

  it("reports a rejection with the owner's comment", async () => {
    const { service } = openService();
    const send = fakeTool("slack_post", ["message.send"]);
    const gate = gateFor(service);
    await gate.wrapTool(send).execute("c1", { text: "hi" });
    const approvalId = gate.pending()[0]?.approvalId ?? "";
    await service.decide({
      approvalId,
      decision: "rejected",
      actor: OWNER,
      comment: "Not to the whole company",
    });
    await expect(gate.wrapTool(send).execute("c2", { text: "hi" })).rejects.toThrow(
      /Neill rejected this action.*Not to the whole company/,
    );
    expect(send.calls).toHaveLength(0);
  });

  it("denies by policy and records the refusal", async () => {
    const { service } = openService();
    const pay = fakeTool("stripe_charge", ["payment.spend"]);
    const gate = createApprovalGate({
      service,
      requester: { agentId: "ceo" },
      policy: { rules: [{ id: "no-money", decision: "deny", effects: ["payment.spend"] }] },
    });
    await expect(gate.wrapTool(pay).execute("c1", { usd: 5 })).rejects.toThrow(/Policy blocked/);
    expect((await service.list({ status: "denied" }))[0]?.policy.ruleId).toBe("no-money");
  });

  it("waits in process for the owner in wait mode", async () => {
    const { service } = openService();
    const send = fakeTool("gmail_send", ["message.send"]);
    const gate = gateFor(service, "wait");
    const unsubscribe = service.subscribe(async (event) => {
      if (event.type === "approval.requested") {
        await service.decide({
          approvalId: event.approval.approvalId,
          decision: "approved",
          actor: OWNER,
        });
      }
    });
    expect(text(await gate.wrapTool(send).execute("c1", EMAIL))).toBe("gmail_send done");
    unsubscribe();

    const slow = createApprovalGate({
      service,
      requester: { agentId: "ceo", runId: "r" },
      mode: "wait",
      waitTimeoutMs: 20,
      pollIntervalMs: 5,
    });
    await expect(slow.wrapTool(send).execute("c2", { to: "x" })).rejects.toBeInstanceOf(
      ApprovalWaitTimeoutError,
    );
  });

  it("wraps terminal, file, custom and MCP tools in capability bindings", async () => {
    const { service } = openService();
    const mcpTool = fakeTool("calendar_create", ["mcp.write", "external.write"]);
    const mcp = {
      list: () => ["calendar"],
      async harnessTools() {
        return [mcpTool];
      },
    };
    const bindings = createApprovalGate({ service, requester: { agentId: "ceo" } }).wrapBindings({
      terminalTools: { tool: fakeTool("bash", ["process.spawn"]) },
      fileTools: { piTools: [fakeTool("write", ["fs.write"])] },
      customTools: [fakeTool("post", ["message.send"])],
      mcp,
    });
    expect(bindings.mcp.list()).toEqual(["calendar"]);
    const [wrappedMcp] = (await bindings.mcp.harnessTools()) as FakeTool[];
    expect(text(await wrappedMcp?.execute("c1", { title: "Sync" }))).toContain("approval");
    expect(mcpTool.calls).toHaveLength(0);
    expect(text(await (bindings.customTools?.[0] as FakeTool).execute("c2", {}))).toContain(
      "approval",
    );
    expect(text(await (bindings.fileTools?.piTools[0] as FakeTool).execute("c3", {}))).toBe(
      "write done",
    );
  });
});

describe("approval routes", () => {
  function ownerContext(scopes: readonly string[]): AuthContext {
    return {
      subject: {
        subjectId: "owner",
        actorType: "human",
        displayName: "Neill",
        scopes,
        roles: [],
      },
      credentialSource: "bearer",
      credentialId: "tok_1",
      audit: {},
    } as unknown as AuthContext;
  }

  async function seed(service: ApprovalServiceContract) {
    return service.request({
      approvalId: "apr-route",
      requester: { agentId: "vp-ops", taskId: "t1" },
      action: { kind: "custom", name: "post", effects: ["message.send"], summary: "Post" },
      policy: { reason: "r" },
    });
  }

  it("lists, shows and decides with the caller recorded", async () => {
    const { service } = openService();
    await seed(service);
    const decided: string[] = [];
    const app = createApprovalRoutes(service, {
      authenticate: (request) =>
        request.headers.get("authorization") === "Bearer read"
          ? ownerContext(["runs:read"])
          : request.headers.get("authorization") === "Bearer owner"
            ? ownerContext(["runs:read", "approvals:decide"])
            : undefined,
      onDecided: (approval) => {
        decided.push(approval.approvalId);
      },
    });
    const call = (url: string, token?: string, init: RequestInit = {}) =>
      app.request(url, {
        ...init,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });

    expect((await call("/approvals")).status).toBe(401);
    const listed = await (await call("/approvals?status=pending", "read")).json();
    expect(listed.approvals.map((a: { approvalId: string }) => a.approvalId)).toEqual([
      "apr-route",
    ]);
    expect((await call("/approvals?status=bogus", "read")).status).toBe(400);

    expect((await call("/approvals/apr-route/approve", "read", { method: "POST" })).status).toBe(
      403,
    );
    const approved = await call("/approvals/apr-route/approve", "owner", {
      method: "POST",
      body: JSON.stringify({ comment: "Go ahead" }),
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).approval.decision).toMatchObject({
      decidedBy: { subjectId: "owner", credentialSource: "bearer" },
      comment: "Go ahead",
    });
    expect(decided).toEqual(["apr-route"]);
    expect((await call("/approvals/apr-route/reject", "owner", { method: "POST" })).status).toBe(
      409,
    );
    expect((await call("/approvals/missing/approve", "owner", { method: "POST" })).status).toBe(
      404,
    );

    const shown = await (await call("/approvals/apr-route", "read")).json();
    expect(shown.events.map((event: { name: string }) => event.name)).toEqual([
      "approval.requested",
      "approval.approved",
    ]);
  });

  it("refuses to start without authentication unless told it is local", () => {
    const { service } = openService();
    expect(() => createApprovalRoutes(service)).toThrow(/authenticate/);
    expect(() => createApprovalRoutes(service, { allowUnauthenticated: true })).not.toThrow();
  });
});

describe("topology approver", () => {
  it("turns a request_approval action into a durable request and waits for the owner", async () => {
    const { service } = openService();
    const approve = createTopologyApprover({
      service,
      requester: { agentId: "coordinator" },
      pollIntervalMs: 5,
      waitTimeoutMs: 2_000,
    });
    service.subscribe(async (event) => {
      if (event.type === "approval.requested") {
        await service.decide({
          approvalId: event.approval.approvalId,
          decision: "rejected",
          actor: OWNER,
        });
      }
    });
    const verdict = await approve({
      runId: "run-1",
      protocol: "pipeline",
      step: 2,
      action: {
        id: "approve-release",
        idempotencyKey: "run-1:approve-release",
        kind: "request_approval",
        payload: { summary: "Publish the report" },
      },
    });
    expect(verdict).toBe(false);
    const [request] = await service.list();
    expect(request?.action).toMatchObject({
      kind: "topology.action",
      summary: "Publish the report",
    });
  });
});

describe("approvals with the turn effect journal (ADR 0059)", () => {
  it("journals a pending approval as not performed, so the retried turn asks again", async () => {
    const { service } = openService();
    const send = fakeTool("gmail_send", ["message.send"]);
    const journal = createMemoryToolEffectJournal("task-1:turn-0");
    const requester = { agentId: "vp-ops", taskId: "task-1", runId: "attempt-1" };
    const first = createToolEffectGuard(journal).wrap(
      createApprovalGate({ service, requester }).wrapTool(send),
    );
    expect(text(await first.execute("c1", EMAIL))).toContain("needs the owner's approval");
    expect(journal.records().map((record) => record.status)).toEqual(["not-performed"]);

    // The owner approves before the same turn is retried: the retry runs the call.
    const [pending] = await service.list({ status: "pending" });
    await service.decide({
      approvalId: pending?.approvalId ?? "",
      decision: "approved",
      actor: OWNER,
    });
    const retry = createToolEffectGuard(journal).wrap(
      createApprovalGate({ service, requester: { ...requester, runId: "attempt-2" } }).wrapTool(
        send,
      ),
    );
    expect(text(await retry.execute("c1", EMAIL))).toBe("gmail_send done");
    expect(send.calls).toHaveLength(1);
    expect(journal.records().map((record) => record.status)).toEqual(["completed"]);
  });

  it("never repeats an approved action that was interrupted mid-run", async () => {
    const { service } = openService();
    const sent: unknown[] = [];
    // Performs the send, then the worker dies before the tool returns.
    const crashing = withAgentHarnessToolEffects(
      {
        name: "gmail_send",
        execute(_id: string, params: unknown) {
          sent.push(params);
          return new Promise(() => {});
        },
      },
      { id: "gmail_send", effects: ["message.send"], reversibility: "irreversible" },
    );
    const requester = { agentId: "vp-ops", taskId: "task-2" };
    const gateFor = (runId: string) =>
      createApprovalGate({ service, requester: { ...requester, runId } });

    // Round 0: request, then the owner approves.
    await gateFor("r0").wrapTool(crashing).execute("c0", EMAIL);
    const [request] = await service.list({ status: "pending" });
    const approvalId = request?.approvalId ?? "";
    await service.decide({ approvalId, decision: "approved", actor: OWNER });

    // Round 1, attempt 1: the approved call starts and the worker dies mid-run.
    const turnJournal = createMemoryToolEffectJournal("task-2:turn-1");
    void createToolEffectGuard(turnJournal)
      .wrap(gateFor("r1-a1").wrapTool(crashing))
      .execute("c1", EMAIL);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect((await service.get(approvalId))?.execution?.state).toBe("started");
    expect(turnJournal.records().map((record) => record.status)).toEqual(["started"]);

    // Round 1, attempt 2 (same turn retried): the journal refuses; nothing runs.
    await expect(
      createToolEffectGuard(turnJournal)
        .wrap(gateFor("r1-a2").wrapTool(crashing))
        .execute("c1", EMAIL),
    ).rejects.toThrow(/may already have happened/);
    expect(sent).toHaveLength(1);

    // Round 2 (a new turn and journal): the approval's claim refuses; it is marked uncertain.
    const nextJournal = createMemoryToolEffectJournal("task-2:turn-2");
    const nextTurn = createToolEffectGuard(nextJournal).wrap(gateFor("r2").wrapTool(crashing));
    await expect(nextTurn.execute("c2", EMAIL)).rejects.toThrow(/may already have happened/);
    expect(sent).toHaveLength(1);
    const uncertain = await service.get(approvalId);
    expect(uncertain?.execution?.state).toBe("uncertain");
    expect((await service.history(approvalId)).at(-1)).toMatchObject({
      name: "approval.execution.failed",
      data: { uncertain: true },
    });

    // Calling it again on purpose needs a fresh approval from the owner.
    expect(text(await nextTurn.execute("c3", EMAIL))).toContain("needs the owner's approval");
    expect(sent).toHaveLength(1);
    expect(await service.list({ status: "pending" })).toHaveLength(1);
  });
});
