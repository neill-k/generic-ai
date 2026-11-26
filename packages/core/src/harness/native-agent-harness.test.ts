import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
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

  it("expands prompt templates in the task", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    let userText = "";
    provider.setResponses([
      (context) => {
        const first = context.messages[0];
        userText = first?.role === "user" ? JSON.stringify(first.content) : "";
        return fauxAssistantMessage("Reviewed.");
      },
    ]);
    const harness = createAgentHarness(
      {
        id: "native-templates",
        adapter: "native",
        model: "faux/root-model",
        execution: { turnMode: "single-turn" },
      },
      {
        native: { resolveModel },
        promptTemplates: [
          {
            name: "review",
            description: "Review a file",
            content: "Review $1 for $2.",
            filePath: "/templates/review.md",
            sourceInfo: {
              path: "/templates/review.md",
              source: "local",
              scope: "temporary",
              origin: "top-level",
            },
          },
        ],
      },
    );
    const result = await harness.run({
      instruction: "/review src/index.ts bugs",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("succeeded");
    expect(userText).toContain("Review src/index.ts for bugs.");
    expect(userText).not.toContain("/review");
  });

  it("expands a skill command in the task", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const skillDir = join(workspaceRoot, "skills", "release-notes");
    await mkdir(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    await writeFile(
      skillFile,
      "---\nname: release-notes\ndescription: Write release notes\n---\nGroup changes by package.\n",
    );
    const { provider, resolveModel } = fauxModels();
    let userText = "";
    provider.setResponses([
      (context) => {
        const first = context.messages[0];
        userText = first?.role === "user" ? JSON.stringify(first.content) : "";
        return fauxAssistantMessage("Written.");
      },
    ]);
    const harness = createAgentHarness(
      {
        id: "native-skill-command",
        adapter: "native",
        model: "faux/root-model",
        execution: { turnMode: "single-turn" },
      },
      { native: { resolveModel } },
    );
    const result = await harness.run({
      instruction: "/skill:release-notes for v2",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
      capabilities: {
        skills: {
          load: async () => ({
            skills: [
              {
                name: "release-notes",
                description: "Write release notes",
                filePath: skillFile,
                baseDir: skillDir,
                disableModelInvocation: false,
                sourceInfo: {
                  path: skillFile,
                  source: "local",
                  scope: "temporary",
                  origin: "top-level",
                  baseDir: skillDir,
                },
              },
            ],
            diagnostics: [],
            prompt: "",
          }),
        },
      },
    });
    expect(result.status).toBe("succeeded");
    expect(userText).toContain('<skill name=\\"release-notes\\"');
    expect(userText).toContain("Group changes by package.");
    expect(userText).toContain("for v2");
  });

  it("loads extensions into native sessions: tools, hooks, and system prompt", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-harness-"));
    const { provider, resolveModel } = fauxModels();
    const lifecycle: string[] = [];
    let systemPrompt = "";
    let tools: string[] = [];
    provider.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        tools = toolNames(context);
        return fauxAssistantMessage([fauxToolCall("ticket_lookup", { id: "T-1" })], {
          stopReason: "toolUse",
        });
      },
      (context) => {
        const last = context.messages.at(-1);
        return fauxAssistantMessage(
          last?.role === "toolResult" ? JSON.stringify(last.content) : "missing",
        );
      },
    ]);
    const harness = createAgentHarness(
      {
        id: "native-extensions",
        adapter: "native",
        model: "faux/root-model",
        execution: { turnMode: "single-turn" },
      },
      {
        native: {
          resolveModel,
          extensions: {
            factories: [
              (api) => {
                api.registerTool({
                  name: "ticket_lookup",
                  label: "Ticket lookup",
                  description: "Look up a ticket.",
                  parameters: Type.Object({ id: Type.String() }),
                  execute: async () => ({
                    content: [{ type: "text", text: "ticket open" }],
                    details: {},
                  }),
                });
                api.on("session_start", () => void lifecycle.push("start"));
                api.on("session_shutdown", () => void lifecycle.push("shutdown"));
                api.on("before_agent_start", (event) => ({
                  systemPrompt: `${event.systemPrompt}\n\nAlways cite ticket ids.`,
                }));
                api.on("tool_result", (event) => ({
                  content: [{ type: "text", text: `${event.toolName}: ticket open (checked)` }],
                }));
              },
            ],
          },
        },
      },
    );
    const result = await harness.run({
      instruction: "Check T-1",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
    });
    expect(result.status).toBe("succeeded");
    expect(tools).toContain("ticket_lookup");
    expect(systemPrompt).toContain("Always cite ticket ids.");
    expect(result.outputText).toContain("ticket_lookup: ticket open (checked)");
    expect(lifecycle).toEqual(["start", "shutdown"]);
    expect(result.events.some((event) => event.name.endsWith("native.extensions_loaded"))).toBe(
      true,
    );
  });
});
