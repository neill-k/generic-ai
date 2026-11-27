// Behaviour adapted from Prime Agent's agent_observe and agent message pause tests
// (PrimeIntellect-ai/prime-agent: crates/pa-core/src/session_engine/agent_messaging/tests.rs,
// crates/pa-daemon/src/agent_messaging/controller_tests.rs, crates/pa-daemon/src/agent_message_ingest.rs).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { Agent } from "@generic-ai/agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@generic-ai/ai";
import { describe, expect, it } from "vitest";

import {
  type AgentActivity,
  agentActivity,
  type ChildRunResult,
  type ChildSession,
  createAgentChildSessionFactory,
  createSubagentRoot,
  createSubagentTools,
  normalizeRecentMessagesWindow,
  recentMessagePreviews,
} from "../src/index.js";

/** A child session with a transcript and activity the test sets by hand. */
class ObservedSession implements ChildSession {
  transcript: unknown[] = [];
  current: AgentActivity = "model";
  #finish: ((result: ChildRunResult) => void) | undefined;

  run(prompt: string, signal: AbortSignal): Promise<ChildRunResult> {
    this.transcript.push({ role: "user", content: prompt, timestamp: 1 });
    return new Promise((resolve) => {
      this.#finish = resolve;
      signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });
  }

  steer(): void {}

  messages(): readonly unknown[] {
    return this.transcript;
  }

  activity(): AgentActivity {
    return this.current;
  }

  finish(result: ChildRunResult): void {
    this.current = "idle";
    this.#finish?.(result);
  }
}

function tree() {
  const sessions = new Map<string, ObservedSession>();
  const root = createSubagentRoot({
    id: "root",
    factory: (request) => {
      const session = new ObservedSession();
      sessions.set(request.name, session);
      return session;
    },
  });
  return { root, session: (name: string) => sessions.get(name) as ObservedSession };
}

describe("agent observation", () => {
  it("validates the preview window like agent_observe", () => {
    expect(normalizeRecentMessagesWindow({})).toEqual({ limit: 8, maxChars: 800 });
    expect(normalizeRecentMessagesWindow({ limit: 50, maxChars: 80 })).toEqual({
      limit: 50,
      maxChars: 80,
    });
    expect(() => normalizeRecentMessagesWindow({ limit: 51 })).toThrow(
      "agent_observe limit must be between 1 and 50",
    );
    expect(() => normalizeRecentMessagesWindow({ limit: 0 })).toThrow("between 1 and 50");
    expect(() => normalizeRecentMessagesWindow({ maxChars: 79 })).toThrow("between 80 and 2000");
    expect(() => normalizeRecentMessagesWindow({ maxChars: 2001 })).toThrow("between 80 and 2000");
    expect(() => normalizeRecentMessagesWindow({ limit: 1.5 })).toThrow(
      "must be an integer when provided",
    );
  });

  it("truncates previews and keeps transcript indexes", () => {
    const messages = [
      { role: "user", content: "first", timestamp: 1 },
      { role: "user", content: "short", timestamp: 42 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm " },
          { type: "text", text: "x".repeat(100) },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
        timestamp: 43,
      },
      { role: "custom", customType: "note", content: "custom text", timestamp: 44 },
      { role: "compactionSummary", summary: "earlier work", timestamp: 45 },
    ];
    const window = recentMessagePreviews(messages, 4, 10);
    expect(window.truncated).toBe(true);
    expect(window.messages[0]).toEqual({
      index: 1,
      role: "user",
      timestamp: 42,
      text: "short",
      truncated: false,
    });
    expect(window.messages[1]).toMatchObject({
      index: 2,
      role: "assistant",
      text: "hmm xxxxxx",
      truncated: true,
      toolCalls: ["read"],
    });
    expect(window.messages[2]).toMatchObject({ customType: "note", text: "custom tex" });
    expect(window.messages[3]).toMatchObject({ role: "compactionSummary", text: "earlier wo" });
    expect(recentMessagePreviews(messages, 8, 800).truncated).toBe(false);
  });

  it("derives activity from agent state", () => {
    expect(agentActivity({ isStreaming: false })).toBe("idle");
    expect(agentActivity({ isStreaming: true })).toBe("busy");
    expect(agentActivity({ isStreaming: true, streamingMessage: {} })).toBe("model");
    expect(
      agentActivity({ isStreaming: true, streamingMessage: {}, pendingToolCalls: new Set(["c"]) }),
    ).toBe("tool");
  });

  it("lists the caller and its family, without the caller in agents", async () => {
    const { root, session } = tree();
    await root.children.spawn({ prompt: "scan the repo", name: "scout" });
    await root.children.spawn({ prompt: "write tests", name: "tester" });
    session("tester").finish({ answer: "done" });
    await root.children.collect(["tester"], 1_000);

    const scout = root.children.liveNodes().find((node) => node.name === "scout");
    scout?.note("halfway");
    const listed = root.observeAgents();
    expect(listed.current).toMatchObject({ id: "root", status: "idle", activity: "idle" });
    expect(listed.current.relationship).toBeUndefined();
    expect(listed.agents.map((agent) => [agent.name, agent.relationship])).toEqual([
      ["scout", "child"],
      ["tester", "child"],
    ]);
    expect(listed.agents[0]).toMatchObject({
      status: "running",
      activity: "model",
      taskStatus: "running",
      messageCount: 1,
      progressNote: "halfway",
    });
    expect(listed.agents[1]).toMatchObject({
      status: "idle",
      activity: "idle",
      taskStatus: "completed",
    });

    // A child sees its parent and siblings.
    const fromScout = scout?.observeAgents();
    expect(fromScout?.current.name).toBe("scout");
    expect(fromScout?.agents.map((agent) => [agent.name, agent.relationship])).toEqual([
      ["main", "parent"],
      ["tester", "sibling"],
    ]);
  });

  it("resolves targets by id or name within the family only", async () => {
    const { root } = tree();
    const scout = await root.children.spawn({ prompt: "a", name: "scout" });
    expect(root.observeAgent("scout").id).toBe(scout.id);
    expect(root.observeAgent(scout.id).name).toBe("scout");
    expect(() => root.observeAgent("nobody")).toThrow("agent nobody is not reachable");
    expect(() => root.observeAgent("root")).toThrow("agent root is not reachable");

    const child = root.children.liveNodes()[0];
    await child?.children.spawn({ prompt: "b", name: "grandchild" });
    expect(() => root.observeAgent("grandchild")).toThrow("is not reachable");
  });

  it("rejects a name two family members share, but an exact id wins", async () => {
    const { root } = tree();
    await root.children.spawn({ prompt: "a", name: "dual" });
    const scout = root.children.liveNodes()[0];
    const nested = await scout?.children.spawn({ prompt: "b", name: "dual-child" });
    // A child's parent (the root, "main") and its own child can share a name.
    scout?.children.rename(nested?.id ?? "", "main");
    expect(() => scout?.observeAgent("main")).toThrow('Ambiguous agent "main"');
    expect(scout?.observeAgent(nested?.id ?? "").relationship).toBe("child");
  });

  it("reads a family member's recent messages", async () => {
    const { root, session } = tree();
    await root.children.spawn({ prompt: "investigate", name: "scout" });
    session("scout").transcript.push({
      role: "assistant",
      content: [{ type: "text", text: "found it" }],
      timestamp: 2,
    });
    const recent = root.recentMessages("scout", { limit: 1 });
    expect(recent).toMatchObject({
      agent: { name: "scout", relationship: "child" },
      limit: 1,
      maxChars: 800,
      truncated: true,
      messages: [{ index: 1, role: "assistant", text: "found it" }],
    });
  });
});

describe("agent messaging pause", () => {
  it("refuses messages while paused and accepts them after resume", async () => {
    const { root } = tree();
    await root.children.spawn({ prompt: "a", name: "scout" });
    const scout = root.children.liveNodes()[0];

    expect(root.pauseMessages()).toEqual({
      paused: true,
      maxMessageChars: 16_384,
      maxPendingPerSession: 20,
    });
    expect(() => scout?.sendMessage({ message: "hello", receiverRole: "parent" })).toThrow(
      "Agent messaging is paused",
    );
    expect(root.observeAgents().current.messagingPaused).toBe(true);
    const broadcast = scout?.broadcast("hi all");
    expect(broadcast?.receipts).toEqual([{ target: "root", error: "Agent messaging is paused" }]);

    expect(root.resumeMessages().paused).toBe(false);
    expect(scout?.sendMessage({ message: "hello", receiverRole: "parent" }).deliveryStatus).toBe(
      "queued",
    );
    expect(root.messagingStatus().paused).toBe(false);
  });

  it("clears waiting agent messages but keeps child notices", async () => {
    const { root, session } = tree();
    await root.children.spawn({ prompt: "a", name: "scout" });
    const scout = root.children.liveNodes()[0];
    scout?.sendMessage({ message: "one", receiverRole: "parent" });
    scout?.sendMessage({ message: "two", receiverRole: "parent" });
    session("scout").finish({ answer: "done" });
    await root.children.collect([], 1_000);

    expect(root.clearMessages()).toEqual({ cleared: 2 });
    expect(root.inbox.peek().map((item) => item.kind)).toEqual(["child-exited"]);
  });
});

describe("observation tools on real agents", () => {
  it("lets a parent read what a running child is doing", async () => {
    const provider = registerFauxProvider({ models: [{ id: "observe-model" }] });
    try {
      const model = provider.getModel();
      const root = createSubagentRoot({ factory: createAgentChildSessionFactory({ model }) });
      const parent = new Agent({
        initialState: { model, systemPrompt: "You lead.", tools: createSubagentTools(root) },
      });
      const unbind = root.bindAgent(parent);
      let release: (() => void) | undefined;
      const childBlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let observed: unknown;
      provider.setResponses([
        // Parent spawns the child.
        fauxAssistantMessage(fauxToolCall("spawn_agent", { prompt: "dig", name: "digger" }), {
          stopReason: "toolUse",
        }),
        // Child's first response waits until the parent has looked.
        async () => {
          await childBlocked;
          return fauxAssistantMessage("dug");
        },
        // Parent observes the child.
        fauxAssistantMessage(fauxToolCall("recent_agent_messages", { target: "digger" }), {
          stopReason: "toolUse",
        }),
        (context) => {
          observed = context.messages.at(-1);
          release?.();
          return fauxAssistantMessage("It is digging.");
        },
      ]);
      await parent.prompt("Delegate the digging.");
      await root.children.collect([], 1_000);
      const result = observed as { role: string; details: { messages: { text: string }[] } };
      expect(result.role).toBe("toolResult");
      expect(result.details.messages.map((message) => message.text)).toEqual(["dig"]);
      expect(root.observeAgents().current.messageCount).toBeGreaterThan(0);
      unbind();
      await root.children.shutdown();
    } finally {
      provider.unregister();
    }
  });
});
