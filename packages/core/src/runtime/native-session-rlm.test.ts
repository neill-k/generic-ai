import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolResultMessage } from "@generic-ai/ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { runCapabilityNativeAgentSession } from "./native-session.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe.skipIf(!hasPython)("native session rlm workspace", () => {
  it("gives the agent a python tool whose code calls sub-models and keeps variables", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "native-rlm-"));
    const faux = registerFauxProvider({ models: [{ id: "rlm-main" }] });
    cleanups.push(() => {
      faux.unregister();
      rmSync(cwd, { recursive: true, force: true });
    });
    let toolNames: string[] = [];
    let systemPrompt = "";
    faux.setResponses([
      (context) => {
        toolNames = (context.tools ?? []).map((tool) => tool.name);
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage([
          fauxToolCall("python", {
            code: "answer = await rlm.llm('What is in chunk 1?')\nprint(len(document), answer)",
          }),
        ]);
      },
      // The sub-model call made from python.
      fauxAssistantMessage("SUB ANSWER"),
      fauxAssistantMessage("All done."),
    ]);
    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: {} as never,
      prompt: "Read the document",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      rlm: { variables: { document: "x".repeat(10_000) } },
    });
    expect(toolNames).toContain("python");
    expect(systemPrompt).toContain("python: Run Python in a persistent workspace");
    const toolResult = (result.messages as { role: string }[]).find(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    expect(toolResult?.content[0]).toEqual({ type: "text", text: "10000 SUB ANSWER" });
    expect(result.outputText).toBe("All done.");
  });
});
