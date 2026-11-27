// RPC mode over in-memory streams with the faux provider. Covers pi's prompt response semantics,
// clear_queue and client behaviour without a real model.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Agent } from "@generic-ai/agent";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AgentModeHost,
  convertToLlm,
  RpcClient,
  runRpcMode,
  SessionManager,
} from "../../src/index.js";

const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.unregister();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(hostOverrides: Partial<AgentModeHost> = {}) {
  const provider = registerFauxProvider({
    models: [{ id: "rpc-model" }, { id: "rpc-reasoner", reasoning: true }],
  });
  registrations.push(provider);
  const dir = mkdtempSync(join(tmpdir(), "generic-ai-rpc-"));
  dirs.push(dir);
  const sessionManager = SessionManager.create(dir, dir);
  const agent = new Agent({
    initialState: { model: provider.getModel(), systemPrompt: "Test." },
    convertToLlm,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const host: AgentModeHost = {
    agent,
    sessionManager,
    availableModels: () => provider.models,
    resolveModel: (providerId, modelId) =>
      providerId === provider.provider ? provider.getModel(modelId) : undefined,
    ...hostOverrides,
  };
  const done = runRpcMode(host, { input, output });
  const client = RpcClient.connect({ input, output });
  return { provider, agent, sessionManager, client, done, input, output };
}

function rawLines(output: PassThrough): () => Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      records.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  return () => records;
}

describe("runRpcMode", () => {
  it("answers a prompt with started, streams events and finishes the turn", async () => {
    const { provider, client, done } = setup();
    provider.setResponses([fauxAssistantMessage("Hello there.")]);
    const events = await client.promptAndWait("Hi");
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("agent_start");
    expect(types).toContain("message_update");
    expect(types.at(-1)).toBe("agent_end");
    expect(await client.getLastAssistantText()).toBe("Hello there.");
    const messages = await client.getMessages();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    await client.stop();
    await done;
  });

  it("rejects a second prompt while streaming unless it says how to queue it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { provider, client, done } = setup();
    provider.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("First answer.");
      },
      fauxAssistantMessage("Steered answer."),
    ]);
    const idle = client.waitForIdle();
    expect(await client.prompt("Start")).toBe("started");
    await requested;
    await expect(client.prompt("Again")).rejects.toThrow(
      "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    );
    expect(await client.prompt("Change course", { streamingBehavior: "steer" })).toBe("queued");
    expect((await client.getState()).pendingMessageCount).toBe(1);
    release();
    await idle;
    expect(await client.getLastAssistantText()).toBe("Steered answer.");
    const state = await client.getState();
    expect(state.pendingMessageCount).toBe(0);
    expect(state.isStreaming).toBe(false);
    await client.stop();
    await done;
  });

  it("hands queued messages back on clear_queue", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { provider, client, done } = setup();
    provider.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("Only answer.");
      },
    ]);
    const idle = client.waitForIdle();
    await client.prompt("Start");
    // Queue only once the model request is out, so the loop's first steering poll has passed.
    await requested;
    await client.steer("Change direction");
    await client.followUp("Summarize when finished");
    expect(await client.clearQueue()).toEqual({
      steering: ["Change direction"],
      followUp: ["Summarize when finished"],
    });
    release();
    await idle;
    const messages = await client.getMessages();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    await client.stop();
    await done;
  });

  it("reports state, switches models and thinking levels, and records them in the session", async () => {
    const { provider, sessionManager, client, done } = setup();
    const state = await client.getState();
    expect(state.model?.id).toBe("rpc-model");
    expect(state.thinkingLevel).toBe("off");
    expect(state.sessionId).toBe(sessionManager.getSessionId());

    const model = await client.setModel(provider.provider, "rpc-reasoner");
    expect(model.id).toBe("rpc-reasoner");
    await expect(client.setModel(provider.provider, "missing")).rejects.toThrow(
      `Model not found: ${provider.provider}/missing`,
    );
    await client.setThinkingLevel("high");
    expect((await client.getState()).thinkingLevel).toBe("high");
    expect(await client.send({ type: "cycle_thinking_level" })).toEqual({ level: "xhigh" });
    expect(await client.send({ type: "get_available_thinking_levels" })).toEqual({
      levels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    });

    const cycled = await client.cycleModel();
    expect(cycled?.model.id).toBe("rpc-model");
    expect((await client.getAvailableModels()).map((entry) => entry.id)).toEqual([
      "rpc-model",
      "rpc-reasoner",
    ]);

    await client.setSessionName("Refactor");
    await expect(client.setSessionName("   ")).rejects.toThrow("Session name cannot be empty");
    expect((await client.getState()).sessionName).toBe("Refactor");

    const types = sessionManager.getEntries().map((entry) => entry.type);
    expect(types).toEqual([
      "model_change",
      "thinking_level_change",
      "thinking_level_change",
      "model_change",
      "session_info",
    ]);
    await client.stop();
    await done;
  });

  it("starts a new session and clears the conversation", async () => {
    const { provider, sessionManager, client, done } = setup();
    provider.setResponses([fauxAssistantMessage("Answer.")]);
    await client.promptAndWait("Question");
    const before = sessionManager.getSessionId();
    expect(await client.newSession()).toEqual({ cancelled: false });
    expect(sessionManager.getSessionId()).not.toBe(before);
    expect(await client.getMessages()).toEqual([]);
    const stats = await client.getSessionStats();
    expect(stats.totalMessages).toBe(0);
    await client.stop();
    await done;
  });

  it("counts messages, tool calls and tokens in get_session_stats", async () => {
    const { provider, client, done } = setup();
    provider.setResponses([fauxAssistantMessage("Answer.")]);
    await client.promptAndWait("Question");
    const stats = await client.getSessionStats();
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.totalMessages).toBe(2);
    expect(stats.tokens.total).toBeGreaterThanOrEqual(0);
    await client.stop();
    await done;
  });

  it("answers unknown commands and bad JSON with error responses", async () => {
    const { input, output, done } = setup({
      commands: () => [{ name: "plan", description: "Plan mode" }],
    });
    const records = rawLines(output);
    input.write("not json\n");
    input.write(`${JSON.stringify({ id: "a", type: "launch_rockets" })}\n`);
    input.write(`${JSON.stringify({ id: "b", type: "get_commands" })}\n`);
    input.write(`${JSON.stringify({ id: "c", type: "set_session_name", name: "" })}\n`);
    input.end();
    await done;
    const responses = records();
    expect(responses[0]).toMatchObject({ type: "response", command: "parse", success: false });
    expect(responses[1]).toEqual({
      id: "a",
      type: "response",
      command: "launch_rockets",
      success: false,
      error: "Unknown command: launch_rockets",
    });
    expect(responses[2]).toEqual({
      id: "b",
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [{ name: "plan", description: "Plan mode" }] },
    });
    expect(responses[3]).toMatchObject({ id: "c", success: false });
  });

  it("emits prompt_error when the host prompt throws after starting", async () => {
    const { client, done } = setup({
      prompt: async () => {
        throw new Error("extension refused");
      },
    });
    const idle = client.waitForIdle();
    expect(await client.prompt("Hi")).toBe("started");
    await expect(idle).rejects.toThrow("extension refused");
    await client.stop();
    await done;
  });

  it("disposes the host when the input ends", async () => {
    let disposed = false;
    const { client, done } = setup({
      dispose: () => {
        disposed = true;
      },
    });
    await client.stop();
    await done;
    expect(disposed).toBe(true);
  });
});
