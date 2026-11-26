import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import { createMemoryToolEffectJournal, withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { defineTool } from "@generic-ai/sdk/pi";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";
import { createAgentHarness } from "./agent-harness.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function fauxModels(): {
  provider: FauxProviderRegistration;
  resolveModel: (ref: string) => Model;
} {
  const provider = registerFauxProvider({
    models: [{ id: "root-model" }, { id: "builder-model" }],
  });
  registrations.push(provider);
  return {
    provider,
    resolveModel: (ref) => {
      const id = ref.split("/").at(-1) ?? ref;
      const model = provider.getModel(id);
      if (model === undefined) {
        throw new Error(`unknown test model ${ref}`);
      }
      return model;
    },
  };
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

function stop(response: string, status?: "completed" | "blocked" | "failed"): AssistantMessage {
  return fauxAssistantMessage(
    [
      fauxToolCall(
        STOP_AND_RESPOND_TOOL_NAME,
        status === undefined ? { response } : { response, status },
      ),
    ],
    { stopReason: "toolUse" },
  );
}

describe("native harness adapter", () => {
  it("runs root and delegated roles on their own models with role-filtered tools", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    const notes: string[] = [];
    const recordNote = withAgentHarnessToolEffects(
      defineTool({
        name: "record_note",
        label: "Record Note",
        description: "Record a build note.",
        parameters: Type.Object({ note: Type.String() }),
        async execute(_toolCallId, params) {
          notes.push(params.note);
          return { content: [{ type: "text" as const, text: "noted" }], details: {} };
        },
      }),
      ["fs.write"],
    );
    const seen: { model: string; tools: string[] }[] = [];
    const observe = (context: Context, model: Model) => {
      seen.push({ model: model.id, tools: toolNames(context) });
    };
    provider.setResponses([
      (context, _options, _state, model) => {
        observe(context, model);
        return fauxAssistantMessage(
          [fauxToolCall("delegate_agent", { roleId: "builder", task: "Write the note." })],
          { stopReason: "toolUse" },
        );
      },
      (context, _options, _state, model) => {
        observe(context, model);
        return fauxAssistantMessage([fauxToolCall("record_note", { note: "built" })], {
          stopReason: "toolUse",
        });
      },
      (context, _options, _state, model) => {
        observe(context, model);
        return stop("Builder finished.");
      },
      (context, _options, _state, model) => {
        observe(context, model);
        return stop("All done.");
      },
    ]);

    const harness = createAgentHarness(
      {
        id: "native-harness",
        adapter: "native",
        model: "faux/root-model",
        policyProfile: "local-dev-full",
        roles: [
          { id: "root", kind: "root", description: "Coordinates the work." },
          {
            id: "builder",
            kind: "builder",
            description: "Builds things.",
            model: "faux/builder-model",
          },
        ],
      },
      { native: { resolveModel } },
    );
    const result = await harness.run({
      instruction: "Build the thing",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
      capabilities: { customTools: [recordNote] },
    });

    expect(result.status).toBe("succeeded");
    expect(result.adapter).toBe("native");
    expect(result.outputText).toBe("All done.");
    expect(notes).toEqual(["built"]);
    expect(seen.map((call) => call.model)).toEqual([
      "root-model",
      "builder-model",
      "builder-model",
      "root-model",
    ]);
    // The coordinator cannot write; the builder can.
    expect(seen[0]?.tools).toContain("delegate_agent");
    expect(seen[0]?.tools).not.toContain("record_note");
    expect(seen[1]?.tools).toContain("record_note");
    expect(seen[1]?.tools).toContain(STOP_AND_RESPOND_TOOL_NAME);

    const names = result.events.map((event) => event.name);
    expect(names).toContain("handoff.requested");
    expect(names).toContain("handoff.completed");
    expect(names.filter((name) => name === "session.completed")).toHaveLength(2);
    expect(result.projections.some((projection) => projection.type === "tool.call.completed")).toBe(
      true,
    );
    expect(result.artifacts.map((artifact) => artifact.id)).toContain("policy-decisions");
  });

  it("replays an outward call on a retried run that shares the effect journal", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    const outbox: string[] = [];
    const sendMessage = withAgentHarnessToolEffects(
      defineTool({
        name: "send_message",
        label: "Send Message",
        description: "Send a message to a customer.",
        parameters: Type.Object({ to: Type.String(), text: Type.String() }),
        async execute(_toolCallId, params) {
          outbox.push(`${params.to}: ${params.text}`);
          return { content: [{ type: "text" as const, text: "sent" }], details: {} };
        },
      }),
      ["message.send"],
    );
    const script = () => [
      () =>
        fauxAssistantMessage(
          [fauxToolCall("delegate_agent", { roleId: "builder", task: "Message Ann." })],
          { stopReason: "toolUse" },
        ),
      () =>
        fauxAssistantMessage([fauxToolCall("send_message", { to: "ann", text: "hello" })], {
          stopReason: "toolUse",
        }),
      () => stop("Sent."),
      () => stop("Done."),
    ];
    const harness = createAgentHarness(
      {
        id: "native-journal",
        adapter: "native",
        model: "faux/root-model",
        policyProfile: "local-dev-full",
        roles: [
          { id: "root", kind: "root", description: "Coordinates the work." },
          { id: "builder", kind: "builder", description: "Does the work." },
        ],
      },
      { native: { resolveModel } },
    );
    const journal = createMemoryToolEffectJournal("task:turn-0");
    for (const attempt of [1, 2]) {
      provider.setResponses(script());
      const result = await harness.run({
        instruction: "Say hello to Ann",
        workspaceRoot,
        runId: `task:turn-0:attempt-${attempt}`,
        artifactDir: join(workspaceRoot, `artifacts-${attempt}`),
        capabilities: { customTools: [sendMessage] },
        effectJournal: journal,
      });
      expect(result.status).toBe("succeeded");
    }
    expect(outbox).toEqual(["ann: hello"]);
    expect(journal.records()).toHaveLength(1);
    expect(journal.records()[0]?.status).toBe("completed");
  });

  it("reports a failed run when the model stops as blocked", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    provider.setResponses([stop("Missing credentials.", "blocked")]);
    const harness = createAgentHarness(
      { id: "native-blocked", adapter: "native", model: "faux/root-model" },
      { native: { resolveModel } },
    );
    const result = await harness.run({
      instruction: "Deploy",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("failed");
    expect(result.outputText).toBe("Missing credentials.");
    expect(result.failureMessage).toBe('Agent stopped with terminal status "blocked".');
  });

  it("reports provider errors as a failed run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
    ]);
    const harness = createAgentHarness(
      { id: "native-error", adapter: "native", model: "faux/root-model" },
      { native: { resolveModel, retry: false } },
    );
    const result = await harness.run({
      instruction: "Anything",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("failed");
    expect(result.failureMessage).toBe("overloaded");
    expect(result.events.map((event) => event.name)).toContain("run.failed");
  });

  it("retries transient provider errors before the run continues", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded_error" }),
      stop("Recovered."),
    ]);
    const harness = createAgentHarness(
      { id: "native-retry", adapter: "native", model: "faux/root-model" },
      { native: { resolveModel, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } },
    );
    const result = await harness.run({
      instruction: "Anything",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("Recovered.");
    expect(result.events.map((event) => event.name)).toContain(
      "plugin.generic-ai-runtime.native.retry",
    );
  });

  it("records each role session as a JSONL file when sessionDir is set", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const sessionDir = join(workspaceRoot, "sessions");
    const { provider, resolveModel } = fauxModels();
    provider.setResponses([stop("Done.")]);
    const harness = createAgentHarness(
      { id: "native-sessions", adapter: "native", model: "faux/root-model" },
      { native: { resolveModel, sessionDir } },
    );
    const result = await harness.run({
      instruction: "Record this",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("succeeded");
    const files = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(sessionDir, files[0] ?? ""), "utf8")).trim().split("\n");
    const records = lines.map(
      (line) => JSON.parse(line) as { type: string; message?: { role: string } },
    );
    expect(records[0]?.type).toBe("session");
    expect(records.map((record) => record.message?.role).filter(Boolean)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("runs single-turn harnesses without the stop tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    let tools: string[] = [];
    provider.setResponses([
      (context) => {
        tools = toolNames(context);
        return fauxAssistantMessage("Single answer.");
      },
    ]);
    const harness = createAgentHarness(
      {
        id: "native-single",
        adapter: "native",
        model: "faux/root-model",
        execution: { turnMode: "single-turn" },
      },
      { native: { resolveModel } },
    );
    const result = await harness.run({
      instruction: "Answer once",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputText).toBe("Single answer.");
    expect(tools).not.toContain(STOP_AND_RESPOND_TOOL_NAME);
  });
});
