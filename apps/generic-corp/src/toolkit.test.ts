import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import { createEnvSecretSource, createSecretsBroker } from "@generic-ai/plugin-secrets";
import { afterEach, describe, expect, it } from "vitest";

import { CompanyConfigError, parseCompanyConfig } from "./company.js";
import { createCompanyTaskExecutor } from "./executor.js";
import { createCompanyRuntime } from "./runtime.js";
import { openCompanyStorage } from "./storage.js";
import { createCompanyToolkit } from "./toolkit.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-toolkit-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

const company = parseCompanyConfig({
  name: "Toolkit Corp",
  models: { ceo: "faux/worker", vp: "faux/worker", ic: "faux/worker" },
  agents: [
    { id: "ceo", role: "ceo", secrets: ["CRM_*"] },
    { id: "analyst", role: "analyst", reportsTo: "ceo" },
  ],
});

describe("company config: tools and secret grants", () => {
  it("accepts web search, MCP connectors and per-agent secret grants", () => {
    const parsed = parseCompanyConfig({
      tools: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a config placeholder.
        webSearch: { provider: "brave", apiKey: "${BRAVE_API_KEY}" },
        mcp: { servers: [{ id: "web", connector: "browser" }] },
      },
      agents: [{ id: "ceo", role: "ceo", secrets: ["GITHUB_TOKEN", "SEARCH_*"] }],
    });
    expect(parsed.tools?.webSearch?.provider).toBe("brave");
    expect(parsed.agents[0]?.secrets).toEqual(["GITHUB_TOKEN", "SEARCH_*"]);
  });

  it("rejects bad tool config and grants with clear messages", () => {
    const agents = [{ id: "ceo", role: "ceo" }];
    expect(() =>
      parseCompanyConfig({ tools: { webSearch: { provider: "bing" } }, agents }),
    ).toThrow(/brave, tavily or searxng/);
    expect(() =>
      parseCompanyConfig({ tools: { webSearch: { provider: "tavily" } }, agents }),
    ).toThrow(/apiKey is required/);
    expect(() =>
      parseCompanyConfig({
        tools: { mcp: { servers: [{ id: "x", transport: "carrier" }] } },
        agents,
      }),
    ).toThrow(CompanyConfigError);
    expect(() =>
      parseCompanyConfig({ agents: [{ id: "ceo", role: "ceo", secrets: ["a b"] }] }),
    ).toThrow(/secret names/);
  });
});

describe("company toolkit", () => {
  it("lists the generic-work tools and explains how to turn web search on", async () => {
    const toolkit = createCompanyToolkit({ company, env: {} });
    cleanups.push(() => toolkit.close());
    const description = toolkit.describe();
    const names = description.tools.map((tool) => tool.name);
    for (const name of ["read", "write", "bash", "web_fetch", "web_search", "document_read"]) {
      expect(names).toContain(name);
    }
    expect(names).toContain("document_write");
    expect(description.connectors).toEqual([]);
    expect(description.webSearch).toEqual({ provider: "auto", configured: false });
    expect(toolkit.secretGrants("ceo")).toEqual(["CRM_*"]);
    expect(toolkit.secretGrants("analyst")).toBeUndefined();

    const root = tempDir();
    const bindings = toolkit.capabilities({
      taskId: "t",
      attemptRunId: "a",
      rootTaskId: "t",
      agentId: "analyst",
      role: "analyst",
      prompt: "p",
      workspaceRoot: root,
    }) as unknown as {
      customTools: readonly {
        name: string;
        execute: (id: string, params: unknown) => Promise<unknown>;
      }[];
    };
    const search = bindings.customTools.find((tool) => tool.name === "web_search");
    await expect(search?.execute("call", { query: "generic ai" })).rejects.toThrow(
      /BRAVE_API_KEY or TAVILY_API_KEY/,
    );
  });

  it("gives agents document tools on the native runtime, with secret grants per agent", async () => {
    const dataDir = tempDir();
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());
    const secrets = createSecretsBroker({
      sources: [
        createEnvSecretSource({ env: { GENERIC_AI_SECRET_CRM_TOKEN: "crm-token-123456" } }),
      ],
    });
    const toolkit = createCompanyToolkit({ company, secrets, env: {} });
    cleanups.push(() => toolkit.close());

    const provider: FauxProviderRegistration = registerFauxProvider({
      models: [{ id: "worker" }],
    });
    cleanups.push(() => provider.unregister());
    const resolveModel = (ref: string): Model => {
      const model = provider.getModel(ref.split("/").at(-1) ?? ref);
      if (model === undefined) {
        throw new Error(`unknown model ${ref}`);
      }
      return model;
    };
    let tools: string[] = [];
    let promptText = "";
    provider.setResponses([
      (context) => {
        tools = toolNames(context);
        promptText = `${context.systemPrompt ?? ""}\n${JSON.stringify(context.messages)}`;
        return fauxAssistantMessage(
          [
            fauxToolCall("document_write", {
              path: "workspace/brief.docx",
              content: "# Brief\n\n- Revenue is up\n- Costs are flat",
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      () =>
        fauxAssistantMessage([fauxToolCall("document_read", { path: "workspace/brief.docx" })], {
          stopReason: "toolUse",
        }),
      (context) => {
        const last = context.messages.at(-1);
        const text = last?.role === "toolResult" ? JSON.stringify(last.content) : "missing";
        return fauxAssistantMessage(
          [fauxToolCall("stop_and_respond", { response: `Read back: ${text}` })],
          { stopReason: "toolUse" },
        );
      },
    ]);

    const executor = createCompanyTaskExecutor({
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      native: { resolveModel },
      capabilities: (input) => toolkit.capabilities(input),
      secretGrants: (agentId) => toolkit.secretGrants(agentId),
    });
    const runtime = createCompanyRuntime({
      company,
      storage,
      agentsRoot: path.join(dataDir, "agents"),
      executor,
    });
    await runtime.initialize();
    const { task } = await runtime.sendMessage({ text: "Write me a short brief as a Word file." });
    await runtime.cascade.drain();

    const settled = await runtime.cascade.get(task.taskId);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.outputText).toContain("Revenue is up");
    for (const name of ["web_search", "web_fetch", "document_read", "document_write"]) {
      expect(tools).toContain(name);
    }
    // The CEO was granted CRM_* and is told the names it may use, never the value.
    expect(promptText).toContain("CRM_TOKEN");
    expect(promptText).not.toContain("crm-token-123456");
    const ceo = await runtime.directory.require("ceo");
    expect((await stat(path.join(ceo.homePath, "workspace", "brief.docx"))).size).toBeGreaterThan(
      0,
    );
  });
});
