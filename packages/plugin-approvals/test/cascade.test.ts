import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type AgentTaskJobPayload,
  type AgentTaskJobResult,
  createAgentDirectory,
  createDelegationCascade,
  createMemoryAgentStore,
  type DelegationCascadeEvent,
} from "@generic-ai/plugin-delegation";
import { createSqliteQueue, createSqliteRunStore } from "@generic-ai/plugin-storage-sqlite";
import {
  type AgentTaskExecutionInput,
  type AgentTaskExecutor,
  type RunActor,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { createManualClock } from "@generic-ai/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  approvalRequesterForTask,
  createApprovalGate,
  createApprovalService,
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

const EMAIL = { to: "press@example.com", subject: "Launch", body: "We launch Monday." };

/**
 * An executor that behaves like an agent with an email tool: on every turn it
 * tries to send the launch email through the approval gate, unless the prompt
 * says the owner rejected it.
 */
function emailingAgent(service: ReturnType<typeof createApprovalService>) {
  const sent: unknown[] = [];
  const prompts: string[] = [];
  const sendEmail = withAgentHarnessToolEffects(
    {
      name: "gmail_send",
      async execute(_id: string, params: unknown) {
        sent.push(params);
        return { content: [{ type: "text", text: "Sent." }] };
      },
    },
    { id: "gmail_send", effects: ["mcp.write"], reversibility: "irreversible" },
  );
  const executor: AgentTaskExecutor = async (input: AgentTaskExecutionInput) => {
    prompts.push(input.prompt);
    if (input.agentId !== "vp-ops") {
      return { status: "succeeded", outputText: `${input.agentId} finished.` };
    }
    if (input.prompt.includes("Rejected by")) {
      return { status: "succeeded", outputText: "Did not send; the owner said no." };
    }
    const gate = createApprovalGate({ service, requester: approvalRequesterForTask(input) });
    const tool = gate.wrapTool(sendEmail);
    const result = (await tool.execute("call-1", EMAIL)) as {
      content: Array<{ text: string }>;
    };
    const text = result.content[0]?.text ?? "";
    if (text.includes("needs the owner's approval")) {
      return { status: "succeeded", outputText: "Waiting for approval to send the launch email." };
    }
    return { status: "succeeded", outputText: `Launch email: ${text}` };
  };
  return { executor, sent, prompts };
}

async function open() {
  const directory = mkdtempSync(path.join(tmpdir(), "gai-approval-cascade-"));
  const file = path.join(directory, "state.db");
  const clock = createManualClock();
  const runStore = createSqliteRunStore({ path: file, now: clock.now });
  const queue = createSqliteQueue<AgentTaskJobPayload, AgentTaskJobResult>({
    path: file,
    now: clock.now,
    maxAttempts: 2,
    leaseMs: 60_000,
    backoff: { baseMs: 0, maxMs: 0 },
  });
  const agents = createAgentDirectory({
    store: createMemoryAgentStore(),
    root: path.join(directory, "agents"),
  });
  await agents.seed([
    { id: "ceo", role: "ceo", title: "CEO" },
    { id: "vp-ops", role: "vp", title: "VP Operations", reportsTo: "ceo" },
  ]);
  const service = createApprovalService({ runStore, now: () => new Date(clock.now()) });
  const agent = emailingAgent(service);
  const events: DelegationCascadeEvent[] = [];
  const cascade = createDelegationCascade({
    runStore,
    queue,
    directory: agents,
    executor: agent.executor,
    approvals: service,
    handIn: "reply",
    now: () => new Date(clock.now()),
    onEvent: (event) => events.push(event),
  });
  cleanups.push(async () => {
    await cascade.stop();
    await queue.close?.();
    await runStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { clock, runStore, queue, service, cascade, agent, events };
}

describe("approvals in the delegation cascade", () => {
  it("parks the task without a worker until the owner approves, then sends once", async () => {
    const { service, cascade, agent, queue, events } = await open();
    const task = await cascade.submit({
      agentId: "vp-ops",
      instruction: "Send the launch email.",
      taskId: "launch",
    });
    await cascade.drain();

    const waiting = await cascade.get(task.taskId);
    expect(waiting?.status).toBe("waiting");
    expect(waiting?.pendingApprovalIds).toHaveLength(1);
    expect(agent.sent).toEqual([]);
    expect(events.map((event) => event.type)).toContain("task.awaiting_approval");
    // Nothing is queued or leased while the owner decides.
    expect(await queue.lease({ names: [cascade.jobName], workerId: "probe" })).toBeUndefined();

    const [request] = await service.list({ status: "pending", taskId: "launch" });
    expect(request?.action).toMatchObject({ name: "gmail_send", input: EMAIL });
    expect(request?.requester).toMatchObject({ agentId: "vp-ops", rootTaskId: "launch" });

    await service.decide({
      approvalId: request?.approvalId ?? "",
      decision: "approved",
      actor: OWNER,
      comment: "Ship it",
    });
    expect(await cascade.approvalDecided(request?.approvalId ?? "")).toBe(true);
    await cascade.drain();

    const done = await cascade.get(task.taskId);
    expect(done?.status).toBe("succeeded");
    expect(done?.outputText).toBe("Launch email: Sent.");
    expect(agent.sent).toEqual([EMAIL]);
    const resumedPrompt = agent.prompts.at(-1) ?? "";
    expect(resumedPrompt).toContain("Approved by Neill.");
    expect(resumedPrompt).toContain('Their note: "Ship it"');
    expect(resumedPrompt).toContain('"to":"press@example.com"');
    expect((await service.get(request?.approvalId ?? ""))?.execution?.state).toBe("succeeded");
  });

  it("resumes with the rejection so the agent can take another path", async () => {
    const { service, cascade, agent } = await open();
    await cascade.submit({ agentId: "vp-ops", instruction: "Send it.", taskId: "t-reject" });
    await cascade.drain();
    const [request] = await service.list({ status: "pending" });
    await service.decide({
      approvalId: request?.approvalId ?? "",
      decision: "rejected",
      actor: OWNER,
      comment: "Wait for legal",
    });
    // Decided from another process: the poller (or recover) finds it.
    expect(await cascade.resumeDecidedApprovals()).toBe(1);
    await cascade.drain();
    const done = await cascade.get("t-reject");
    expect(done?.status).toBe("succeeded");
    expect(done?.outputText).toBe("Did not send; the owner said no.");
    expect(agent.sent).toEqual([]);
    expect(agent.prompts.at(-1)).toContain('Their note: "Wait for legal"');
  });

  it("resumes after the request expires and cancels open requests with the task", async () => {
    const { service, cascade, clock } = await open();
    await cascade.submit({ agentId: "vp-ops", instruction: "Send it.", taskId: "t-expire" });
    await cascade.drain();
    clock.advance(73 * 60 * 60 * 1000);
    expect(await cascade.resumeDecidedApprovals()).toBe(1);
    expect((await service.list({ status: "expired" })).length).toBe(1);

    await cascade.submit({ agentId: "vp-ops", instruction: "Send it.", taskId: "t-cancel" });
    await cascade.drain({ maxJobs: 2 });
    expect((await cascade.get("t-cancel"))?.status).toBe("waiting");
    expect(await cascade.cancel("t-cancel")).toBe(true);
    const cancelled = await service.list({ taskId: "t-cancel" });
    expect(cancelled.map((approval) => approval.status)).toEqual(["cancelled"]);
  });

  it("keeps a restarted process waiting and resumes it on recover", async () => {
    const { service, cascade, runStore, queue } = await open();
    await cascade.submit({ agentId: "vp-ops", instruction: "Send it.", taskId: "t-restart" });
    await cascade.drain();
    // A new cascade over the same database: nothing to do until the owner decides.
    const agent = emailingAgent(service);
    const restarted = createDelegationCascade({
      runStore,
      queue,
      directory: createAgentDirectory({
        store: createMemoryAgentStore(),
        root: mkdtempSync(path.join(tmpdir(), "gai-approval-restart-")),
      }),
      executor: agent.executor,
      approvals: service,
      handIn: "reply",
    });
    expect(await restarted.recover()).toBe(0);
    const [request] = await service.list({ status: "pending" });
    await service.decide({
      approvalId: request?.approvalId ?? "",
      decision: "approved",
      actor: OWNER,
    });
    expect(await restarted.recover()).toBe(1);
  });
});
