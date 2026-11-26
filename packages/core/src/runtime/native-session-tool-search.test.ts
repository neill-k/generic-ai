import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import { SessionManager } from "@generic-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import { runCapabilityNativeAgentSession } from "./native-session.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function provider() {
  const registration = registerFauxProvider({ models: [{ id: "tool-search" }] });
  registrations.push(registration);
  return registration;
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

function tools(calls: string[]) {
  const make = (name: string, description: string) => ({
    name,
    label: name,
    description,
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (_id: string, params: { query?: string }) => {
      calls.push(`${name}:${params.query ?? ""}`);
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  });
  return [
    make("mcp__github__list_issues", "List issues in a GitHub repository."),
    make("mcp__docs__search", "Search the documentation."),
    make("local_note", "Write a local note."),
  ];
}

describe("native session tool search", () => {
  it("defers MCP tools and declares the ones tool_search loads from the next call", async () => {
    const faux = provider();
    const calls: string[] = [];
    const seen: string[][] = [];
    faux.setResponses([
      (context) => {
        seen.push(toolNames(context));
        return fauxAssistantMessage(fauxToolCall("tool_search", { query: "github issues" }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        seen.push(toolNames(context));
        return fauxAssistantMessage(
          fauxToolCall("mcp__github__list_issues", { query: "open bugs" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        seen.push(toolNames(context));
        return fauxAssistantMessage("Found them.");
      },
    ]);

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: { customTools: tools(calls) } as never,
      prompt: "Find open bugs.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      toolSearch: true,
    });

    expect(result.failureMessage).toBeUndefined();
    expect(seen[0]).toContain("tool_search");
    expect(seen[0]).toContain("local_note");
    expect(seen[0]).not.toContain("mcp__github__list_issues");
    expect(seen[0]).not.toContain("mcp__docs__search");
    expect(seen[1]).toContain("mcp__github__list_issues");
    expect(seen[1]).not.toContain("mcp__docs__search");
    expect(calls).toEqual(["mcp__github__list_issues:open bugs"]);
  });

  it("declares every tool when tool search is off", async () => {
    const faux = provider();
    const seen: string[][] = [];
    faux.setResponses([
      (context) => {
        seen.push(toolNames(context));
        return fauxAssistantMessage("Done.");
      },
    ]);
    await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: { customTools: tools([]) } as never,
      prompt: "Say done.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
    });
    expect(seen[0]).toContain("mcp__docs__search");
    expect(seen[0]).not.toContain("tool_search");
  });

  it("uses a custom defer rule and keeps loaded tools on resume", async () => {
    const faux = provider();
    const manager = SessionManager.inMemory("/tmp/work");
    const seen: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "note" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Loaded."),
    ]);
    const options = {
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: { customTools: tools([]) } as never,
      turnMode: "single-turn" as const,
      sessionManager: manager,
      compaction: false as const,
      retry: false as const,
      toolSearch: { defer: (tool: { name: string }) => tool.name === "local_note" },
    };
    await runCapabilityNativeAgentSession({ ...options, prompt: "Load the note tool." });

    faux.setResponses([
      (context) => {
        seen.push(toolNames(context));
        return fauxAssistantMessage("Still here.");
      },
    ]);
    await runCapabilityNativeAgentSession({ ...options, prompt: "Anything else?" });
    expect(seen[0]).toContain("local_note");
    expect(seen[0]).toContain("mcp__docs__search");
  });
});
