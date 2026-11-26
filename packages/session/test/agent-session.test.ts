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

import {
  compactIfNeeded,
  convertToLlm,
  persistAgentMessages,
  restoreAgentContext,
  runWithRetry,
  SessionManager,
} from "../src/index.js";

const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.unregister();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(contextWindow = 200_000) {
  const provider = registerFauxProvider({ models: [{ id: "session-model", contextWindow }] });
  registrations.push(provider);
  const model = provider.getModel();
  const agent = new Agent({ initialState: { model, systemPrompt: "Test." }, convertToLlm });
  return { provider, model, agent };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "generic-ai-session-"));
  dirs.push(dir);
  return dir;
}

describe("session persistence", () => {
  it("writes each finished message to the session file and restores it on resume", async () => {
    const { provider, model, agent } = setup();
    const dir = tempDir();
    const manager = SessionManager.create(dir, dir);
    const unsubscribe = persistAgentMessages(agent, manager);
    provider.setResponses([fauxAssistantMessage("First answer.")]);
    await agent.prompt("First question");
    unsubscribe();

    const file = manager.getSessionFile();
    expect(file).toBeDefined();
    const reopened = SessionManager.open(file ?? "", dir);
    const resumed = new Agent({ initialState: { model, systemPrompt: "Test." }, convertToLlm });
    restoreAgentContext(resumed, reopened);
    expect(resumed.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    persistAgentMessages(resumed, reopened);
    provider.setResponses([fauxAssistantMessage("Second answer.")]);
    await resumed.prompt("Second question");
    expect(reopened.buildSessionContext().messages).toHaveLength(4);
  });
});

describe("retry on transient errors", () => {
  it("retries an overloaded response and keeps only the successful answer in context", async () => {
    const { provider, agent } = setup();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded_error" }),
      fauxAssistantMessage("Recovered."),
    ]);
    const notices: number[] = [];
    const retries = await runWithRetry(agent, () => agent.prompt("Hello"), {
      policy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      onRetry: (notice) => {
        notices.push(notice.attempt);
      },
    });
    expect(retries).toBe(1);
    expect(notices).toEqual([1]);
    const roles = agent.state.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
    const last = agent.state.messages.at(-1);
    expect(last?.role === "assistant" && last.stopReason).toBe("stop");
  });

  it("does not retry quota errors", async () => {
    const { provider, agent } = setup();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 insufficient_quota" }),
      fauxAssistantMessage("Should not be reached."),
    ]);
    const retries = await runWithRetry(agent, () => agent.prompt("Hello"), {
      policy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    });
    expect(retries).toBe(0);
    expect(provider.state.callCount).toBe(1);
  });

  it("recovers once from a context overflow through onContextOverflow", async () => {
    const { provider, agent } = setup();
    provider.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      }),
      fauxAssistantMessage("Answered after compacting."),
    ]);
    let compactions = 0;
    await runWithRetry(agent, () => agent.prompt("Hello"), {
      policy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      onContextOverflow: async () => {
        compactions += 1;
        return true;
      },
    });
    expect(compactions).toBe(1);
    expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const last = agent.state.messages.at(-1);
    expect(last?.role === "assistant" && last.stopReason).toBe("stop");
  });

  it("stops when an overflow cannot be compacted, and does not loop on a second one", async () => {
    const overflow = () =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "context_length_exceeded" });
    const first = setup();
    first.provider.setResponses([overflow(), fauxAssistantMessage("Not reached.")]);
    await runWithRetry(first.agent, () => first.agent.prompt("Hello"), {
      onContextOverflow: async () => false,
    });
    expect(first.provider.state.callCount).toBe(1);

    const second = setup();
    second.provider.setResponses([overflow(), overflow(), fauxAssistantMessage("Not reached.")]);
    let calls = 0;
    await runWithRetry(second.agent, () => second.agent.prompt("Hello"), {
      onContextOverflow: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(1);
    expect(second.provider.state.callCount).toBe(2);
  });

  it("does not report a retry when the run is already aborted", async () => {
    const { provider, agent } = setup();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded_error" }),
      fauxAssistantMessage("Should not be reached."),
    ]);
    const controller = new AbortController();
    const notices: number[] = [];
    const retries = await runWithRetry(
      agent,
      async () => {
        await agent.prompt("Hello");
        controller.abort();
      },
      {
        policy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        signal: controller.signal,
        onRetry: (notice) => {
          notices.push(notice.attempt);
        },
      },
    );
    expect(retries).toBe(0);
    expect(notices).toEqual([]);
    expect(provider.state.callCount).toBe(1);
  });

  it("stops after maxRetries", async () => {
    const { provider, agent } = setup();
    const overloaded = () =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" });
    provider.setResponses([overloaded(), overloaded(), overloaded()]);
    const retries = await runWithRetry(agent, () => agent.prompt("Hello"), {
      policy: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    });
    expect(retries).toBe(2);
    expect(provider.state.callCount).toBe(3);
  });
});

describe("auto-compaction", () => {
  it("summarises older turns once the context nears the window and reloads the agent", async () => {
    const { provider, model, agent } = setup(4_000);
    const manager = SessionManager.inMemory("/tmp/work");
    persistAgentMessages(agent, manager);
    const filler = "x".repeat(4_000);
    provider.setResponses([
      fauxAssistantMessage(`One ${filler}`),
      fauxAssistantMessage(`Two ${filler}`),
      fauxAssistantMessage(`Three ${filler}`),
      fauxAssistantMessage("Summary of the earlier work."),
    ]);
    await agent.prompt(`First ${filler}`);
    await agent.prompt(`Second ${filler}`);
    await agent.prompt(`Third ${filler}`);

    const result = await compactIfNeeded(agent, manager, {
      model,
      settings: { reserveTokens: 1_000, keepRecentTokens: 1_500 },
    });
    expect(result?.summary).toContain("Summary of the earlier work.");
    expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
    expect(agent.state.messages[0]?.role).toBe("compactionSummary");
    expect(agent.state.messages.length).toBeLessThan(6);
  });

  it("lets beforeCompact cancel a compaction or steer its summary", async () => {
    const { provider, model, agent } = setup(4_000);
    const manager = SessionManager.inMemory("/tmp/work");
    persistAgentMessages(agent, manager);
    const filler = "x".repeat(4_000);
    let summaryPrompt = "";
    provider.setResponses([
      fauxAssistantMessage(`One ${filler}`),
      fauxAssistantMessage(`Two ${filler}`),
      fauxAssistantMessage(`Three ${filler}`),
      (context) => {
        summaryPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage("Summary.");
      },
    ]);
    await agent.prompt(`First ${filler}`);
    await agent.prompt(`Second ${filler}`);
    await agent.prompt(`Third ${filler}`);
    const settings = { reserveTokens: 1_000, keepRecentTokens: 1_500 };

    const infos: number[] = [];
    const cancelled = await compactIfNeeded(agent, manager, {
      model,
      settings,
      beforeCompact: (info) => {
        infos.push(info.contextWindow);
        return { cancel: true };
      },
    });
    expect(cancelled).toBeUndefined();
    expect(infos).toEqual([4_000]);
    expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);

    const result = await compactIfNeeded(agent, manager, {
      model,
      settings,
      beforeCompact: () => ({ customInstructions: "Keep the word PINEAPPLE." }),
    });
    expect(result?.summary).toContain("Summary.");
    expect(summaryPrompt).toContain("Keep the word PINEAPPLE.");
  });

  it("does nothing while the context fits", async () => {
    const { provider, model, agent } = setup(200_000);
    const manager = SessionManager.inMemory("/tmp/work");
    persistAgentMessages(agent, manager);
    provider.setResponses([fauxAssistantMessage("Short.")]);
    await agent.prompt("Hi");
    expect(await compactIfNeeded(agent, manager, { model })).toBeUndefined();
  });
});
