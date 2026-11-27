// Cases adapted from pi (badlogic/pi-mono, packages/coding-agent/test/extensions-runner.test.ts and
// extensions-input-event.test.ts). Copyright (c) 2026 Earendil Inc. MIT License; see
// THIRD_PARTY_NOTICES.md.

import { Agent, type AgentMessage, type AgentTool } from "@generic-ai/agent";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  resolveModel,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionRunner } from "../src/runner.js";
import type { ExtensionError } from "../src/types.js";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
  for (const registration of registrations.splice(0)) registration.unregister();
});

function tool(name: string, text = "ok"): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text }], details: {} }),
  };
}

function text(message: AgentMessage | undefined): string {
  if (message === undefined || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("ExtensionRunner registration", () => {
  it("collects tools from multiple extensions and keeps the first of a duplicate name", async () => {
    const runner = new ExtensionRunner();
    const errors: ExtensionError[] = [];
    runner.onError((error) => errors.push(error));
    await runner.load((api) => api.registerTool(tool("alpha", "first")), "/ext/a.ts");
    await runner.load((api) => {
      api.registerTool(tool("beta"));
      api.registerTool(tool("alpha", "second"));
    }, "/ext/b.ts");

    expect(runner.getTools().map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.extensionPath).toBe("/ext/b.ts");
    expect(errors[0]?.error).toContain("/ext/a.ts");
  });

  it("rejects extension tools without a parameter schema", async () => {
    const runner = new ExtensionRunner();
    const errors: ExtensionError[] = [];
    runner.onError((error) => errors.push(error));
    await runner.load((api) => {
      api.registerTool({ ...tool("bad"), parameters: undefined as unknown as object });
    }, "/ext/a.ts");
    expect(runner.getTools()).toHaveLength(0);
    expect(errors[0]?.error).toContain("no parameter schema");
  });

  it("suffixes duplicate commands in load order and finds them by invocation name", async () => {
    const runner = new ExtensionRunner();
    const calls: string[] = [];
    await runner.load(
      (api) => api.registerCommand("deploy", { handler: () => void calls.push("a") }),
      "/ext/a.ts",
    );
    await runner.load(
      (api) => api.registerCommand("deploy", { handler: () => void calls.push("b") }),
      "/ext/b.ts",
    );
    expect(runner.getCommands().map((command) => command.invocationName)).toEqual([
      "deploy",
      "deploy:2",
    ]);
    expect(await runner.preparePrompt("/deploy:2 now")).toEqual({
      kind: "handled",
      command: "deploy:2",
    });
    expect(calls).toEqual(["b"]);
  });

  it("passes command arguments and leaves unknown slash text as a prompt", async () => {
    const runner = new ExtensionRunner();
    let received = "";
    await runner.load(
      (api) =>
        api.registerCommand("note", {
          handler: (args) => {
            received = args;
          },
        }),
      "/ext/a.ts",
    );
    await runner.preparePrompt("/note  remember the milk ");
    expect(received).toBe("remember the milk");
    expect(await runner.preparePrompt("/other thing")).toEqual({
      kind: "prompt",
      text: "/other thing",
    });
  });

  it("does not record an extension whose factory throws", async () => {
    const runner = new ExtensionRunner();
    await expect(
      runner.load(() => {
        throw new Error("boom");
      }, "/ext/a.ts"),
    ).rejects.toThrow("boom");
    expect(runner.extensions).toHaveLength(0);
  });
});

describe("ExtensionRunner dispatch", () => {
  it("calls error listeners when a handler throws and still runs the others", async () => {
    const runner = new ExtensionRunner();
    const errors: ExtensionError[] = [];
    const seen: string[] = [];
    runner.onError((error) => errors.push(error));
    await runner.load((api) => {
      api.on("session_start", () => {
        throw new Error("handler failed");
      });
    }, "/ext/a.ts");
    await runner.load((api) => {
      api.on("session_start", () => void seen.push("b"));
    }, "/ext/b.ts");

    await runner.emit({ type: "session_start" });

    expect(seen).toEqual(["b"]);
    expect(errors).toEqual([
      { extensionPath: "/ext/a.ts", event: "session_start", error: "handler failed" },
    ]);
  });

  it("allows self-removal without skipping neighbouring handlers", async () => {
    const runner = new ExtensionRunner();
    const seen: string[] = [];
    await runner.load((api) => {
      const off = api.on("turn_start", () => {
        seen.push("first");
        off();
      });
      api.on("turn_start", () => void seen.push("second"));
    }, "/ext/a.ts");

    await runner.emit({ type: "turn_start", turnIndex: 0 });
    await runner.emit({ type: "turn_start", turnIndex: 1 });

    expect(seen).toEqual(["first", "second", "second"]);
  });

  it("defers handlers registered during a dispatch until the next dispatch", async () => {
    const runner = new ExtensionRunner();
    const seen: string[] = [];
    await runner.load((api) => {
      api.on("agent_start", () => {
        seen.push("outer");
        api.on("agent_start", () => void seen.push("late"));
      });
    }, "/ext/a.ts");

    await runner.emit({ type: "agent_start" });
    expect(seen).toEqual(["outer"]);
    await runner.emit({ type: "agent_start" });
    expect(seen).toEqual(["outer", "outer", "late"]);
  });

  it("reports whether an event has handlers", async () => {
    const runner = new ExtensionRunner();
    expect(runner.hasHandlers("context")).toBe(false);
    await runner.load((api) => void api.on("context", () => undefined), "/ext/a.ts");
    expect(runner.hasHandlers("context")).toBe(true);
  });

  it("chains input transforms and stops at the first handled", async () => {
    const runner = new ExtensionRunner();
    await runner.load((api) => {
      api.on("input", (event) => ({ action: "transform", text: `${event.text}!` }));
      api.on("input", (event) => ({ action: "transform", text: event.text.toUpperCase() }));
    }, "/ext/a.ts");
    expect(await runner.emitInput("hi")).toEqual({ action: "transform", text: "HI!" });

    await runner.load((api) => {
      api.on("input", (event) => (event.text === "HI!" ? { action: "handled" } : undefined));
      api.on("input", () => {
        throw new Error("never reached");
      });
    }, "/ext/b.ts");
    expect(await runner.emitInput("hi")).toEqual({ action: "handled" });
    expect(await runner.emitInput("")).toEqual({ action: "transform", text: "!" });
  });

  it("chains tool result modifications and keeps fields a partial patch leaves out", async () => {
    const runner = new ExtensionRunner();
    await runner.load((api) => {
      api.on("tool_result", (event) => ({
        content: [{ type: "text", text: `${(event.content[0] as { text: string }).text} +a` }],
        details: { a: true },
      }));
      api.on("tool_result", (event) => ({
        content: [{ type: "text", text: `${(event.content[0] as { text: string }).text} +b` }],
      }));
      api.on("tool_result", () => ({ isError: true }));
    }, "/ext/a.ts");

    const patch = await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "base" }],
      details: undefined,
      isError: false,
    });

    expect(patch).toEqual({
      content: [{ type: "text", text: "base +a +b" }],
      details: { a: true },
      isError: true,
    });
  });

  it("returns undefined when no tool result handler changes anything", async () => {
    const runner = new ExtensionRunner();
    await runner.load((api) => void api.on("tool_result", () => undefined), "/ext/a.ts");
    expect(
      await runner.emitToolResult({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        input: {},
        content: [],
        details: undefined,
        isError: false,
      }),
    ).toBeUndefined();
  });

  it("keeps system prompt updates in sync across before_agent_start handlers", async () => {
    const runner = new ExtensionRunner();
    const seen: string[] = [];
    await runner.load((api) => {
      api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt} A` }));
      api.on("before_agent_start", (event) => {
        seen.push(event.systemPrompt);
        return {
          systemPrompt: `${event.systemPrompt} B`,
          messages: [{ role: "user", content: "note", timestamp: 0 }],
        };
      });
    }, "/ext/a.ts");

    const outcome = await runner.emitBeforeAgentStart("task", "Base");

    expect(seen).toEqual(["Base A"]);
    expect(outcome.systemPrompt).toBe("Base A B");
    expect(outcome.messages).toHaveLength(1);
  });

  it("lets any handler cancel compaction and joins custom instructions", async () => {
    const runner = new ExtensionRunner();
    await runner.load((api) => {
      api.on("session_before_compact", () => ({ customInstructions: "Keep file paths." }));
      api.on("session_before_compact", () => ({ customInstructions: "Keep decisions." }));
    }, "/ext/a.ts");
    const event = { type: "session_before_compact" as const, tokens: 10, contextWindow: 20 };
    expect(await runner.emitBeforeCompact(event)).toEqual({
      customInstructions: "Keep file paths.\n\nKeep decisions.",
    });

    await runner.load(
      (api) => void api.on("session_before_compact", () => ({ cancel: true })),
      "/b",
    );
    expect(await runner.emitBeforeCompact(event)).toEqual({
      cancel: true,
      customInstructions: "Keep file paths.\n\nKeep decisions.",
    });
  });
});

describe("ExtensionRunner bound to an agent", () => {
  function setup() {
    const provider = registerFauxProvider({ models: [{ id: "ext-model" }] });
    registrations.push(provider);
    const agent = new Agent({
      initialState: {
        model: provider.getModel(),
        systemPrompt: "Base.",
        tools: [tool("read", "file text")],
      },
    });
    return { provider, agent };
  }

  it("adds extension tools, blocks tool calls, and patches tool results", async () => {
    const { provider, agent } = setup();
    const runner = new ExtensionRunner();
    const errors: ExtensionError[] = [];
    runner.onError((error) => errors.push(error));
    await runner.load((api) => {
      api.registerTool(tool("lookup", "found it"));
      api.registerTool(tool("read", "shadow"));
      api.on("tool_call", (event) =>
        event.toolName === "read" ? { block: true, reason: "reads are off" } : undefined,
      );
      api.on("tool_result", (event) => ({
        content: [
          {
            type: "text",
            text: `[${event.toolName}] ${(event.content[0] as { text: string }).text}`,
          },
        ],
      }));
    }, "/ext/a.ts");
    runner.bindAgent(agent);

    expect(agent.state.tools.map((entry) => entry.name)).toEqual(["read", "lookup"]);
    expect(errors[0]?.error).toContain('"read" is already provided');

    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("read", {}), fauxToolCall("lookup", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done."),
    ]);
    await agent.prompt("Go");

    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => text(message))).toEqual(["reads are off", "[lookup] found it"]);
    expect(results.map((message) => message.role === "toolResult" && message.isError)).toEqual([
      true,
      false,
    ]);
  });

  it("transforms the context sent to the model and forwards agent events", async () => {
    const { provider, agent } = setup();
    const runner = new ExtensionRunner();
    const events: string[] = [];
    let sentMessages = 0;
    await runner.load((api) => {
      api.on("context", (event) => ({ messages: event.messages.slice(-1) }));
      for (const name of ["agent_start", "turn_start", "turn_end", "agent_end"] as const) {
        api.on(name, () => void events.push(name));
      }
    }, "/ext/a.ts");
    runner.bindAgent(agent);
    provider.setResponses([
      (context) => {
        sentMessages = context.messages.length;
        return fauxAssistantMessage("One.");
      },
      (context) => {
        sentMessages = context.messages.length;
        return fauxAssistantMessage("Two.");
      },
    ]);

    await agent.prompt("First");
    await agent.prompt("Second");

    expect(agent.state.messages).toHaveLength(4);
    expect(sentMessages).toBe(1);
    expect(events.slice(0, 4)).toEqual(["agent_start", "turn_start", "turn_end", "agent_end"]);
  });

  it("runs prompts through input, commands, and before_agent_start", async () => {
    const { provider, agent } = setup();
    const runner = new ExtensionRunner();
    let commandRan = false;
    await runner.load((api) => {
      api.registerCommand("status", {
        handler: () => {
          commandRan = true;
        },
      });
      api.on("input", (event) => ({
        action: "transform",
        text: event.text.replace("{name}", "Ada"),
      }));
      api.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt} Be brief.`,
      }));
    }, "/ext/a.ts");
    const unbind = runner.bindAgent(agent);
    let systemPrompt = "";
    let userText = "";
    provider.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        userText = text(context.messages.at(-1));
        return fauxAssistantMessage("Hello Ada.");
      },
    ]);

    const run = (prompt: string) => agent.prompt(prompt);
    expect(await runner.runPrompt("/status", run)).toEqual({ kind: "handled", command: "status" });
    expect(commandRan).toBe(true);
    expect(provider.state.callCount).toBe(0);

    expect(await runner.runPrompt("Greet {name}", run)).toEqual({
      kind: "prompt",
      text: "Greet Ada",
    });
    expect(systemPrompt).toBe("Base. Be brief.");
    expect(userText).toBe("Greet Ada");

    unbind();
    expect(agent.transformContext).toBeUndefined();
    expect(agent.beforeToolCall).toBeUndefined();
  });
});

describe("provider hooks and model selection", () => {
  function chatStream(): string {
    const chunk = {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    };
    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  }

  it("lets extensions replace the payload, add headers and observe the response", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(chatStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "req-9" },
      });
    }) as typeof fetch;
    const model = { ...resolveModel("openrouter/some/model"), headers: { "X-Remove": "gone" } };
    const agent = new Agent({
      initialState: { model, systemPrompt: "Base." },
      streamOptions: { apiKey: "k", maxRetries: 0, fetch: fetchStub, headers: { "X-Caller": "1" } },
    });
    const runner = new ExtensionRunner();
    const responses: Array<{ status: number; id: string | undefined }> = [];
    await runner.load((api) => {
      api.on("before_provider_request", (event) => ({
        ...(event.payload as Record<string, unknown>),
        temperature: 0.1,
      }));
      api.on("before_provider_request", (event) => {
        expect((event.payload as Record<string, unknown>)["temperature"]).toBe(0.1);
        return undefined;
      });
      api.on("before_provider_headers", (event) => {
        event.headers["X-Trace"] = "trace-1";
        event.headers["X-Remove"] = null;
      });
      api.on("after_provider_response", (event) => {
        responses.push({ status: event.status, id: event.headers["x-request-id"] });
      });
    }, "/ext/provider.ts");
    const unbind = runner.bindAgent(agent);

    await agent.prompt("hi");
    expect(requests[0]?.body["temperature"]).toBe(0.1);
    expect(requests[0]?.headers.get("x-trace")).toBe("trace-1");
    expect(requests[0]?.headers.get("x-caller")).toBe("1");
    expect(requests[0]?.headers.get("x-remove")).toBeNull();
    expect(responses).toEqual([{ status: 200, id: "req-9" }]);

    unbind();
    expect(agent.streamOptions?.onPayload).toBeUndefined();
  });

  it("fires model_select and thinking_level_select when an extension switches them", async () => {
    const provider = registerFauxProvider({ models: [{ id: "first" }, { id: "second" }] });
    registrations.push(provider);
    const first = provider.getModel("first");
    if (first === undefined) throw new Error("missing model");
    const agent = new Agent({ initialState: { model: first } });
    const runner = new ExtensionRunner();
    const seen: string[] = [];
    await runner.load((api) => {
      api.on("model_select", (event) => {
        seen.push(`model ${event.previousModel?.id} -> ${event.model.id} (${event.source})`);
      });
      api.on("thinking_level_select", (event) => {
        seen.push(`thinking ${event.previousLevel} -> ${event.level}`);
      });
    }, "/ext/select.ts");
    runner.bindAgent(agent);
    const context = runner.createContext();
    const second = provider.getModel("second");
    if (second === undefined) throw new Error("missing model");
    await context.setModel(second);
    await context.setThinkingLevel("high");
    expect(agent.state.model.id).toBe("second");
    expect(context.getModel()?.id).toBe("second");
    expect(context.getThinkingLevel()).toBe("high");
    expect(seen).toEqual(["model first -> second (set)", "thinking off -> high"]);
  });
});
