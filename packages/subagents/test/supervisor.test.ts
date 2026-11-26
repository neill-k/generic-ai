// Behaviour adapted from Prime Agent's RLM child host tests (PrimeIntellect-ai/prime-agent,
// crates/pa-daemon/src/rlm_children, crates/pa-core/src/session_engine/agent_messaging/tests.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";

import {
  type AgentNode,
  type ChildRunResult,
  type ChildSession,
  type ChildSessionRequest,
  createSubagentRoot,
  type SubagentEvent,
  type SubagentTreeOptions,
} from "../src/index.js";

/** A child session the test finishes by hand. */
class FakeSession implements ChildSession {
  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  #finish: ((result: ChildRunResult) => void) | undefined;
  disposed = false;

  constructor(readonly request: ChildSessionRequest) {}

  run(prompt: string, signal: AbortSignal): Promise<ChildRunResult> {
    this.prompts.push(prompt);
    return new Promise((resolve) => {
      this.#finish = resolve;
      signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });
  }

  steer(message: string): void {
    this.steered.push(message);
  }

  pendingMessageCount(): number {
    return this.steered.length;
  }

  finish(result: ChildRunResult): void {
    this.#finish?.(result);
  }

  dispose(): void {
    this.disposed = true;
  }
}

function setup(options: Partial<SubagentTreeOptions> = {}) {
  const sessions = new Map<string, FakeSession>();
  const events: SubagentEvent[] = [];
  let now = 1_000;
  const root = createSubagentRoot({
    id: "root",
    factory: (request) => {
      const session = new FakeSession(request);
      sessions.set(request.name, session);
      return session;
    },
    now: () => now,
    onEvent: (event) => events.push(event),
    ...options,
  });
  const session = (name: string): FakeSession => {
    const found = sessions.get(name);
    if (found === undefined) {
      throw new Error(`no session ${name}`);
    }
    return found;
  };
  return {
    root,
    session,
    events,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SubagentSupervisor", () => {
  it("spawns, lists, and collects children", async () => {
    const { root, session, tick } = setup();
    const handle = await root.children.spawn({ prompt: "  research   the\nAPI ", name: "scout" });
    expect(handle).toMatchObject({ name: "scout", depth: 1 });
    expect(handle.id.startsWith("sub_")).toBe(true);
    const second = await root.children.spawn({ prompt: "write tests" });
    expect(second.name).toBe("agent-1");

    expect(root.children.list()).toMatchObject([
      { name: "scout", status: "running", label: "research the API", depth: 1 },
      { name: "agent-1", status: "running", label: "write tests" },
    ]);

    tick(250);
    session("scout").finish({ answer: "  the API\n has three endpoints ", toolUseCount: 2 });
    await settle();
    const [scout, other] = await root.children.collect();
    expect(scout).toMatchObject({
      name: "scout",
      status: "completed",
      settled: true,
      answerPreview: "the API has three endpoints",
      answerText: "  the API\n has three endpoints ",
      durationMs: 250,
      toolUseCount: 2,
      repliedSinceTask: false,
    });
    expect(other).toMatchObject({ name: "agent-1", status: "running", settled: false });

    // A settled child leaves a notice in the parent's inbox.
    expect(root.inbox.read()).toMatchObject([
      { kind: "child-exited", sender: "scout", text: "the API has three endpoints" },
    ]);
  });

  it("waits for running children up to the timeout and returns snapshots", async () => {
    const { root, session } = setup();
    await root.children.spawn({ prompt: "a", name: "a" });
    await root.children.spawn({ prompt: "b", name: "b" });

    const snapshot = await root.children.collect(["a", "b"], 20);
    expect(snapshot.map((result) => result.status)).toEqual(["running", "running"]);

    setTimeout(() => session("a").finish({ answer: "A" }), 5);
    setTimeout(() => session("b").finish({ error: "boom" }), 10);
    const results = await root.children.collect([], 5_000);
    expect(results).toMatchObject([
      { name: "a", status: "completed", answerText: "A" },
      { name: "b", status: "error", error: "boom" },
    ]);
    expect(root.inbox.read({ kind: "child-failed" })).toMatchObject([
      { sender: "b", text: "boom" },
    ]);

    const controller = new AbortController();
    await root.children.spawn({ prompt: "c", name: "c" });
    setTimeout(() => controller.abort(), 5);
    const aborted = await root.children.collect(["c"], 60_000, controller.signal);
    expect(aborted[0]?.status).toBe("running");
  });

  it("validates spawn and collect input", async () => {
    const { root } = setup({ maxRunningChildren: 1 });
    await expect(root.children.spawn({ prompt: "  " })).rejects.toThrow(
      "spawn_agent prompt must be a non-empty string",
    );
    await expect(root.children.spawn({ prompt: "x", name: " " })).rejects.toThrow(
      "spawn_agent name must not be empty",
    );
    await expect(root.children.spawn({ prompt: "x", name: "n".repeat(65) })).rejects.toThrow(
      "spawn_agent name must be at most 64 characters",
    );
    await expect(root.children.spawn({ prompt: "x", name: "all" })).rejects.toThrow(
      "Broadcast agent messaging is not supported",
    );
    await expect(root.children.spawn({ prompt: "x", thinking: "max" })).rejects.toThrow(
      "spawn_agent thinking must be one of: off, minimal, low, medium, high, xhigh",
    );
    await root.children.spawn({ prompt: "x", name: "worker" });
    await expect(root.children.spawn({ prompt: "y", name: "other" })).rejects.toThrow(
      "Too many running subagents: 1 running, limit is 1",
    );
    await expect(root.children.collect(["ghost"])).rejects.toThrow(
      'No direct child matches "ghost" in the current parent session',
    );
    await expect(root.children.collect([" "])).rejects.toThrow(
      "collect_agents targets must be non-empty strings",
    );
    await expect(root.children.collect([], -1)).rejects.toThrow(
      "collect_agents timeout_ms must be a non-negative integer up to 2147483647",
    );
    await expect(root.children.collect([], 1.5)).rejects.toThrow("timeout_ms");
  });

  it("keeps names unique among live children and frees them on delete", async () => {
    const { root, session, events } = setup();
    await root.children.spawn({ prompt: "x", name: "worker" });
    await expect(root.children.spawn({ prompt: "y", name: "worker" })).rejects.toThrow(
      'Agent name "worker" is unavailable: an agent of that name already exists at depth 1 under this parent',
    );

    const deleted = await root.children.delete("worker");
    expect(deleted).toMatchObject({
      outcome: "deleted",
      subagent: { name: "worker", status: "cancelled" },
    });
    expect(session("worker").disposed).toBe(true);
    expect(root.children.list()).toEqual([]);
    // A deleted child leaves no inbox notice.
    expect(root.inbox.count().count).toBe(0);
    // Deleting again repeats the receipt; collecting it returns the cancelled result.
    expect(await root.children.delete("worker")).toMatchObject({ outcome: "deleted" });
    expect(await root.children.collect(["worker"])).toMatchObject([
      { name: "worker", status: "cancelled", settled: true },
    ]);

    const again = await root.children.spawn({ prompt: "y", name: "worker" });
    expect(again.name).toBe("worker");
    expect(events.map((event) => event.type)).toEqual(["spawned", "settled", "deleted", "spawned"]);
  });

  it("renames children", async () => {
    const { root, events } = setup();
    await root.children.spawn({ prompt: "x", name: "a" });
    await root.children.spawn({ prompt: "x", name: "b" });
    expect(root.children.rename("a", " alpha ")).toBe("alpha");
    expect(() => root.children.rename("alpha", "b")).toThrow('Agent name "b" is unavailable');
    expect(() => root.children.rename("zeta", "c")).toThrow(
      'No direct subagent matches "zeta" in the current parent session',
    );
    expect(root.children.list().map((entry) => entry.name)).toEqual(["alpha", "b"]);
    expect(events.at(-1)).toMatchObject({ type: "renamed", from: "a", to: "alpha" });
  });

  it("limits the depth of the tree", async () => {
    const { root } = setup({ maxDepth: 2 });
    await root.children.spawn({ prompt: "x", name: "child" });
    const child = root.children.liveNodes()[0] as AgentNode;
    await child.children.spawn({ prompt: "y", name: "grandchild" });
    const grandchild = child.children.liveNodes()[0] as AgentNode;
    expect(grandchild.depth).toBe(2);
    expect(grandchild.canSpawn).toBe(false);
    await expect(grandchild.children.spawn({ prompt: "z" })).rejects.toThrow(
      "spawn_agent is not available at depth 2: the deepest subagent level is 2",
    );
  });

  it("stops descendants on delete and shutdown", async () => {
    const { root, session } = setup();
    await root.children.spawn({ prompt: "x", name: "child" });
    const child = root.children.liveNodes()[0] as AgentNode;
    await child.children.spawn({ prompt: "y", name: "grandchild" });
    await root.children.delete("child");
    expect(child.children.list()[0]?.status).toBe("cancelled");
    expect(session("grandchild").disposed).toBe(true);

    await root.children.spawn({ prompt: "z", name: "other" });
    await root.children.shutdown();
    expect(root.children.list()[0]?.status).toBe("cancelled");
  });

  it("does not register a child whose session fails to build", async () => {
    const root = createSubagentRoot({
      factory: () => {
        throw new Error('spawn_agent model "nope" is not available');
      },
    });
    await expect(root.children.spawn({ prompt: "x", name: "w", model: "nope" })).rejects.toThrow(
      'spawn_agent model "nope" is not available',
    );
    expect(root.children.list()).toEqual([]);
  });
});

describe("agent messages in a tree", () => {
  it("delivers between parent, children, and siblings", async () => {
    const { root, session, events } = setup();
    await root.children.spawn({ prompt: "x", name: "scout" });
    await root.children.spawn({ prompt: "y", name: "builder" });
    const [scout, builder] = root.children.liveNodes() as [AgentNode, AgentNode];

    const toChild = root.sendMessage({
      message: "  focus on auth  ",
      receiverRole: "child",
      receiverName: "scout",
    });
    expect(toChild).toMatchObject({
      target: { id: scout.id, name: "scout" },
      message: "focus on auth",
      deliveryStatus: "delivered",
      receiverRole: "child",
    });
    expect(toChild.id.startsWith("agentmsg_")).toBe(true);
    expect(session("scout").steered).toEqual(["[agent-message from parent:main]\n\nfocus on auth"]);

    scout.sendMessage({
      message: "share the schema",
      receiverRole: "sibling",
      receiverName: "builder",
    });
    expect(session("builder").steered).toEqual([
      "[agent-message from sibling:scout]\n\nshare the schema",
    ]);

    // The root is not bound to an agent, so its messages wait in its inbox.
    const toParent = builder.sendMessage({ message: "need a key", receiverRole: "parent" });
    expect(toParent.deliveryStatus).toBe("queued");
    expect(toParent.queuedAt).toBeDefined();
    expect(root.inbox.read()).toMatchObject([
      { kind: "agent-message", sender: "builder", text: "need a key" },
    ]);
    expect(root.children.list()[1]?.repliedSinceTask).toBe(true);
    expect(events.filter((event) => event.type === "message")).toHaveLength(3);

    expect(() =>
      scout.sendMessage({ message: "x", receiverRole: "child", receiverName: "y" }),
    ).toThrow('No child matches "y"');
    expect(() => root.sendMessage({ message: "x", receiverRole: "parent" })).toThrow(
      "No parent matches the current agent",
    );
  });

  it("restarts a settled child with the message", async () => {
    const { root, session } = setup();
    await root.children.spawn({ prompt: "task", name: "worker" });
    session("worker").finish({ answer: "first" });
    await settle();
    expect(root.children.list()[0]?.status).toBe("completed");

    root.sendMessage({ message: "one more thing", receiverRole: "child", receiverName: "worker" });
    expect(session("worker").prompts).toEqual([
      "task",
      "[agent-message from parent:main]\n\none more thing",
    ]);
    expect(root.children.list()[0]).toMatchObject({ status: "running", answerPreview: "first" });
    session("worker").finish({ answer: "second" });
    expect(await root.children.collect(["worker"], 1_000)).toMatchObject([
      { status: "completed", answerText: "second" },
    ]);
  });

  it("broadcasts to the family and records failed deliveries", async () => {
    const { root } = setup({ maxPendingMessages: 1 });
    await root.children.spawn({ prompt: "x", name: "a" });
    await root.children.spawn({ prompt: "y", name: "b" });
    root.sendMessage({ message: "first", receiverRole: "child", receiverName: "a" });
    const { receipts } = root.broadcast("  everyone  ");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      error: "Target session has too many pending messages: 1 unfinished, limit is 1",
    });
    expect(receipts[1]).toMatchObject({ message: "everyone", deliveryStatus: "delivered" });
    expect(
      createSubagentRoot({ factory: () => new FakeSession({} as ChildSessionRequest) }).broadcast(
        "hi",
      ),
    ).toEqual({ receipts: [] });
  });

  it("delivers to a bound root agent while it runs", async () => {
    const { root } = setup();
    const steered: string[] = [];
    const agent = {
      state: { isStreaming: true },
      steer: (message: { content: string }) => void steered.push(message.content),
      peekQueuedMessages: () => steered,
    };
    const unbind = root.bindAgent(agent);
    await root.children.spawn({ prompt: "x", name: "w" });
    const child = root.children.liveNodes()[0] as AgentNode;
    expect(child.sendMessage({ message: "done soon", receiverRole: "parent" }).deliveryStatus).toBe(
      "delivered",
    );
    expect(steered).toEqual(["[agent-message from child:w]\n\ndone soon"]);
    agent.state.isStreaming = false;
    expect(child.sendMessage({ message: "idle now", receiverRole: "parent" }).deliveryStatus).toBe(
      "queued",
    );
    unbind();
    expect(child.sendMessage({ message: "unbound", receiverRole: "parent" }).deliveryStatus).toBe(
      "queued",
    );
    expect(root.inbox.count().byKind["agent-message"]).toBe(2);
  });

  it("records progress notes on the child's roster row", async () => {
    const { root, tick } = setup();
    await root.children.spawn({ prompt: "x", name: "w" });
    const child = root.children.liveNodes()[0] as AgentNode;
    expect(child.note("  halfway  ")).toEqual({ accepted: true });
    expect(child.note("again")).toMatchObject({ accepted: false, retryAfterMs: 10_000 });
    tick(10_000);
    expect(child.note("three quarters")).toEqual({ accepted: true });
    expect(root.children.list()[0]?.progressNote).toBe("three quarters");
    expect(() => child.note("")).toThrow("progress_note message must be a non-empty string");
  });
});
