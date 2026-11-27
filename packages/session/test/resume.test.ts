import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentMessage } from "@generic-ai/agent";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolResultMessage,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  convertToLlm,
  findResumePoint,
  INTERRUPTED_TOOL_TEXT,
  pendingToolCalls,
  prepareSessionResume,
  SessionManager,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(...args: Parameters<typeof fauxAssistantMessage>): AssistantMessage {
  return {
    ...fauxAssistantMessage(...args),
    api: "faux",
    provider: "faux",
    model: "m",
  } as AssistantMessage;
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

function session(messages: readonly AgentMessage[]) {
  const dir = mkdtempSync(join(tmpdir(), "generic-ai-resume-"));
  dirs.push(dir);
  const manager = SessionManager.create(dir, dir);
  for (const message of messages) {
    manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  }
  const agent = new Agent({ convertToLlm });
  return { manager, agent };
}

describe("findResumePoint", () => {
  it("names where a conversation stopped", () => {
    expect(findResumePoint([])).toEqual({ kind: "empty" });
    expect(findResumePoint([user("hi")])).toEqual({ kind: "continue", reason: "user-message" });
    const answer = assistant("Done.");
    expect(findResumePoint([user("hi"), answer])).toEqual({ kind: "complete", message: answer });
    const calling = assistant([fauxToolCall("read", { path: "a" }, { id: "c1" })], {
      stopReason: "toolUse",
    });
    expect(findResumePoint([user("hi"), calling])).toEqual({
      kind: "continue",
      reason: "interrupted-tools",
    });
    expect(findResumePoint([user("hi"), calling, toolResult("c1", "read", "x")])).toEqual({
      kind: "continue",
      reason: "tool-results",
    });
    expect(
      findResumePoint([user("hi"), assistant([], { stopReason: "error", errorMessage: "boom" })]),
    ).toEqual({ kind: "continue", reason: "failed-response" });
  });

  it("finds tool calls whose results were never saved", () => {
    const calling = assistant(
      [
        fauxToolCall("read", { path: "a" }, { id: "c1" }),
        fauxToolCall("bash", { command: "ls" }, { id: "c2" }),
      ],
      { stopReason: "toolUse" },
    );
    const messages = [user("hi"), calling, toolResult("c1", "read", "x")];
    expect(pendingToolCalls(messages).map((call) => call.id)).toEqual(["c2"]);
    expect(findResumePoint(messages)).toEqual({ kind: "continue", reason: "interrupted-tools" });
  });
});

describe("prepareSessionResume", () => {
  it("answers cut-off tool calls with an error instead of running them again", () => {
    const calling = assistant(
      [
        fauxToolCall("read", { path: "a" }, { id: "c1" }),
        fauxToolCall("bash", { command: "rm x" }, { id: "c2" }),
      ],
      { stopReason: "toolUse" },
    );
    const { manager, agent } = session([user("hi"), calling, toolResult("c1", "read", "x")]);
    expect(prepareSessionResume(agent, manager)).toEqual({
      kind: "continue",
      reason: "interrupted-tools",
    });
    const last = agent.state.messages.at(-1) as ToolResultMessage;
    expect(last).toMatchObject({ role: "toolResult", toolCallId: "c2", isError: true });
    expect(last.content[0]).toEqual({ type: "text", text: INTERRUPTED_TOOL_TEXT });
    // Saved, so a second restart does not add it again.
    const reopened = SessionManager.open(manager.getSessionFile() ?? "");
    const again = new Agent({ convertToLlm });
    expect(prepareSessionResume(again, reopened)).toEqual({
      kind: "continue",
      reason: "tool-results",
    });
    expect(again.state.messages).toHaveLength(4);
  });

  it("sets a failed last response aside so the step is tried again", () => {
    const { manager, agent } = session([
      user("hi"),
      assistant([], { stopReason: "aborted", errorMessage: "Request was aborted" }),
    ]);
    expect(prepareSessionResume(agent, manager)).toEqual({
      kind: "continue",
      reason: "failed-response",
    });
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
    // The file keeps the failed entry; the branch no longer includes it.
    expect(manager.getEntries()).toHaveLength(2);
    expect(manager.buildSessionContext().messages).toHaveLength(1);
  });

  it("leaves a finished conversation alone", () => {
    const { manager, agent } = session([user("hi"), assistant("Done.")]);
    const point = prepareSessionResume(agent, manager);
    expect(point.kind).toBe("complete");
    expect(manager.getEntries()).toHaveLength(2);
  });
});
