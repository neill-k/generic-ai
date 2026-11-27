import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type ToolResultMessage,
} from "@generic-ai/ai";
import { SessionManager } from "@generic-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import { runCapabilityNativeAgentSession } from "./native-session.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "native-resume-"));
  const faux = registerFauxProvider({ models: [{ id: "resume" }] });
  cleanups.push(() => {
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
  });
  const model = faux.getModel();
  const assistant = (...args: Parameters<typeof fauxAssistantMessage>): AssistantMessage =>
    ({
      ...fauxAssistantMessage(...args),
      api: model.api,
      provider: model.provider,
      model: model.id,
    }) as AssistantMessage;
  const file = join(dir, "agent.jsonl");
  const saved = (...messages: Parameters<SessionManager["appendMessage"]>[0][]) => {
    const manager = SessionManager.open(file, dir, dir);
    for (const message of messages) manager.appendMessage(message);
    return file;
  };
  const open = () => SessionManager.open(file, dir, dir);
  return { dir, faux, model, assistant, saved, open };
}

function toolResult(id: string, name: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("native session resume", () => {
  it("continues from the last completed step without sending the prompt again", async () => {
    const s = setup();
    s.saved(
      { role: "user", content: "Count the files", timestamp: 1 },
      s.assistant([fauxToolCall("ls", { path: "." }, { id: "c1" })], { stopReason: "toolUse" }),
      toolResult("c1", "ls", "a.txt b.txt"),
    );
    let seen: Context | undefined;
    s.faux.setResponses([
      (context) => {
        seen = context;
        return fauxAssistantMessage("There are 2 files.");
      },
    ]);
    const result = await runCapabilityNativeAgentSession({
      cwd: s.dir,
      model: s.model,
      capabilities: {} as never,
      prompt: "Count the files",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      sessionManager: s.open(),
      resume: true,
    });
    expect(result.outputText).toBe("There are 2 files.");
    expect(seen?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const resumed = result.events.find((event) => event.name.endsWith("native.session_resumed"));
    expect(JSON.stringify(resumed)).toContain('"reason":"tool-results"');
    // The answer was saved after the earlier steps.
    expect(
      s
        .open()
        .buildSessionContext()
        .messages.map((message) => message.role),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("returns a finished answer without calling the model", async () => {
    const s = setup();
    s.saved({ role: "user", content: "Say hi", timestamp: 1 }, s.assistant("Hi there."));
    const result = await runCapabilityNativeAgentSession({
      cwd: s.dir,
      model: s.model,
      capabilities: {} as never,
      prompt: "Say hi",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      sessionManager: s.open(),
      resume: true,
    });
    expect(result.outputText).toBe("Hi there.");
    expect(s.faux.state.callCount).toBe(0);
  });

  it("returns a stop_and_respond answer in stop-tool mode without calling the model", async () => {
    const s = setup();
    s.saved(
      { role: "user", content: "Do it", timestamp: 1 },
      s.assistant(
        [
          fauxToolCall(
            "stop_and_respond",
            { response: "Finished the report.", status: "completed" },
            { id: "s1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      toolResult("s1", "stop_and_respond", "Agent loop stopped; final response captured."),
    );
    const result = await runCapabilityNativeAgentSession({
      cwd: s.dir,
      model: s.model,
      capabilities: {} as never,
      prompt: "Do it",
      compaction: false,
      retry: false,
      sessionManager: s.open(),
      resume: true,
    });
    expect(result.outputText).toBe("Finished the report.");
    expect(result.terminalStatus).toBe("completed");
    expect(s.faux.state.callCount).toBe(0);
  });

  it("keeps working in stop-tool mode until the agent stops", async () => {
    const s = setup();
    s.saved({ role: "user", content: "Do it", timestamp: 1 });
    s.faux.setResponses([
      fauxAssistantMessage("Working on it."),
      fauxAssistantMessage([fauxToolCall("stop_and_respond", { response: "Done now." })], {
        stopReason: "toolUse",
      }),
    ]);
    const result = await runCapabilityNativeAgentSession({
      cwd: s.dir,
      model: s.model,
      capabilities: {} as never,
      prompt: "Do it",
      compaction: false,
      retry: false,
      sessionManager: s.open(),
      resume: true,
    });
    expect(result.outputText).toBe("Done now.");
    expect(s.faux.state.callCount).toBe(2);
  });

  it("sends the prompt as usual when nothing was saved", async () => {
    const s = setup();
    s.faux.setResponses([fauxAssistantMessage("Fresh answer.")]);
    const result = await runCapabilityNativeAgentSession({
      cwd: s.dir,
      model: s.model,
      capabilities: {} as never,
      prompt: "New question",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      sessionManager: s.open(),
      resume: true,
    });
    expect(result.outputText).toBe("Fresh answer.");
  });
});
