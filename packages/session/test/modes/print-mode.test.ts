// Print-mode cases follow pi's packages/coding-agent/test/print-mode.test.ts (text output, error
// exit code, truncation warning), run against the faux provider.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@generic-ai/agent";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { convertToLlm, runPrintMode, SessionManager } from "../../src/index.js";

const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.unregister();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const provider = registerFauxProvider({ models: [{ id: "print-model" }] });
  registrations.push(provider);
  const agent = new Agent({
    initialState: { model: provider.getModel(), systemPrompt: "Test." },
    convertToLlm,
  });
  const out: string[] = [];
  const err: string[] = [];
  return {
    provider,
    agent,
    out,
    err,
    write: (text: string) => out.push(text),
    writeError: (text: string) => err.push(text),
  };
}

describe("runPrintMode", () => {
  it("writes the final answer in text mode and exits 0", async () => {
    const { provider, agent, out, err, write, writeError } = setup();
    provider.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
    let disposed = false;
    const code = await runPrintMode(
      {
        agent,
        dispose: () => {
          disposed = true;
        },
      },
      { mode: "text", initialMessage: "one", messages: ["two"], write, writeError },
    );
    expect(code).toBe(0);
    expect(out.join("")).toBe("Second.\n");
    expect(err).toEqual([]);
    expect(disposed).toBe(true);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("returns 1 and writes the error to stderr when the answer failed", async () => {
    const { provider, agent, out, err, write, writeError } = setup();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" }),
    ]);
    const code = await runPrintMode(
      { agent },
      { mode: "text", initialMessage: "hi", write, writeError },
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("provider exploded");
  });

  it("warns on stderr and returns 1 when the response was truncated", async () => {
    const { provider, agent, out, err, write, writeError } = setup();
    provider.setResponses([fauxAssistantMessage("Partial", { stopReason: "length" })]);
    const code = await runPrintMode(
      { agent },
      { mode: "text", initialMessage: "hi", write, writeError },
    );
    expect(code).toBe(1);
    expect(out.join("")).toBe("Partial\n");
    expect(err.join("")).toContain("output token limit");
  });

  it("writes the session header and every event as JSON lines in json mode", async () => {
    const { provider, agent, out, write, writeError } = setup();
    const dir = mkdtempSync(join(tmpdir(), "generic-ai-print-"));
    dirs.push(dir);
    const sessionManager = SessionManager.create(dir, dir);
    provider.setResponses([fauxAssistantMessage("Done.")]);
    const code = await runPrintMode(
      { agent, sessionManager },
      { mode: "json", initialMessage: "hi", write, writeError },
    );
    expect(code).toBe(0);
    const records = out.map((line) => JSON.parse(line) as { type: string });
    expect(records[0]?.type).toBe("session");
    const types = records.map((record) => record.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types.at(-1)).toBe("agent_end");
    // Finished messages were saved to the session.
    expect(
      sessionManager
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => (entry as { message: { role: string } }).message.role),
    ).toEqual(["user", "assistant"]);
  });

  it("returns 1 when the prompt throws", async () => {
    const { agent, err, write, writeError } = setup();
    const code = await runPrintMode(
      {
        agent,
        prompt: async () => {
          throw new Error("extension refused");
        },
      },
      { mode: "text", initialMessage: "hi", write, writeError },
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("extension refused");
  });
});
