import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import { createMemoryAuthStore } from "@generic-ai/plugin-auth-identity";
import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PERMISSIONS,
  decidePermission,
  gateToolsWithPermissions,
  parsePermissions,
} from "./permissions.js";
import type { RefusedActionInput } from "./refusals.js";
import { createGenericCorpServer } from "./server.js";
import { createCompanyToolkit } from "./toolkit.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/** The smallest goal an agent can draft: the hand-in has a summary. */
const TRIVIAL_GOAL = {
  objective: "Do what the owner asked.",
  definitionOfDone: ["The work is handed in with a summary."],
  validators: [
    { id: "handed-in", kind: "output_schema", schema: { type: "object", required: ["summary"] } },
  ],
};

describe("owner permissions in Generic Corp", () => {
  it("refuses an action outside the permissions on the spot, logs it, and allows it once turned on", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-permissions-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const sent: unknown[] = [];
    const sendEmail = withAgentHarnessToolEffects(
      {
        name: "send_email",
        label: "Send email",
        description: "Send an email.",
        parameters: Type.Object({ to: Type.String(), body: Type.String() }),
        async execute(_id: string, params: unknown) {
          sent.push(params);
          return { content: [{ type: "text" as const, text: "sent" }], details: {} };
        },
      },
      ["message.send"],
    );
    const company = {
      name: "Permission Corp",
      models: { ceo: "faux/worker", vp: "faux/worker", ic: "faux/worker" },
      agents: [{ id: "ceo", role: "ceo" }],
    };
    const base = createCompanyToolkit({ company, env: {} });
    cleanups.push(() => base.close());
    const toolkit = {
      ...base,
      capabilities: (input: Parameters<typeof base.capabilities>[0]) => {
        const bindings = base.capabilities(input) as unknown as { customTools?: unknown[] };
        return {
          ...bindings,
          customTools: [...(bindings.customTools ?? []), sendEmail],
        } as unknown as ReturnType<typeof base.capabilities>;
      },
    };

    const provider: FauxProviderRegistration = registerFauxProvider({ models: [{ id: "worker" }] });
    cleanups.push(() => provider.unregister());
    const resolveModel = (ref: string): Model => {
      const model = provider.getModel(ref.split("/").at(-1) ?? ref);
      if (model === undefined) {
        throw new Error(`unknown model ${ref}`);
      }
      return model;
    };
    const email = { to: "customer@example.com", body: "Your order shipped." };
    const results: string[] = [];
    const prompts: string[] = [];
    const recordResult = (context: { messages: readonly { role: string; content: unknown }[] }) => {
      const last = context.messages.at(-1);
      results.push(last?.role === "toolResult" ? JSON.stringify(last.content) : "");
    };
    const setGoal = () =>
      fauxAssistantMessage([fauxToolCall("set_goal", TRIVIAL_GOAL)], { stopReason: "toolUse" });
    const handIn = (summary: string) => [
      () =>
        fauxAssistantMessage([fauxToolCall("submit_work", { summary, deliverables: [] })], {
          stopReason: "toolUse",
        }),
      () =>
        fauxAssistantMessage([fauxToolCall("stop_and_respond", { response: summary })], {
          stopReason: "toolUse",
        }),
    ];
    provider.setResponses([
      // Turn 1: sending is off, so the call is refused at once and the agent drafts instead.
      (context) => {
        prompts.push(JSON.stringify(context.messages[0]?.content));
        return setGoal();
      },
      () => fauxAssistantMessage([fauxToolCall("send_email", email)], { stopReason: "toolUse" }),
      (context) => {
        recordResult(context);
        return handIn("Sending is off; I drafted the email.")[0]!();
      },
      handIn("Sending is off; I drafted the email.")[1]!,
      // Turn 2, after the owner turns sending on.
      setGoal,
      () => fauxAssistantMessage([fauxToolCall("send_email", email)], { stopReason: "toolUse" }),
      (context) => {
        recordResult(context);
        return handIn("Email sent.")[0]!();
      },
      handIn("Email sent.")[1]!,
    ]);

    const server = await createGenericCorpServer({
      environment: {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        trustProxyHeaders: false,
        insecureNoAuth: true,
        workers: false,
      },
      env: {},
      company,
      toolkit,
      executorOptions: { native: { resolveModel } },
      authStore: createMemoryAuthStore(),
      log: () => undefined,
    });
    cleanups.push(() => server.stop());

    const json = async (method: string, pathname: string, body?: unknown) => {
      const response = await server.fetch(
        new Request(`http://127.0.0.1${pathname}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    // Standing rules reach every agent turn, beside what is off.
    const ruled = await json("PUT", "/api/permissions", {
      standingRules: ["Always sign emails as the Generic Corp team."],
    });
    expect(ruled.status).toBe(200);
    expect(ruled.body["saved"]).toBe(true);

    const first = await server.runtime.sendMessage({ text: "Tell the customer it shipped." });
    await server.runtime.cascade.drain();

    expect(sent).toEqual([]);
    expect(results[0]).toMatch(/Refused: the owner has not allowed sending messages/);
    expect(prompts[0]).toContain("Always sign emails as the Generic Corp team.");
    expect(prompts[0]).toContain("sending messages on the owner's behalf");
    const done = await server.runtime.cascade.get(first.task.taskId);
    expect(done?.status).toBe("succeeded");
    expect(done?.outputText).toBe("Sending is off; I drafted the email.");

    const refusals = await json("GET", "/api/refusals");
    expect(refusals.body["refusals"]).toMatchObject([
      {
        kind: "permission",
        agentId: "ceo",
        taskId: first.task.taskId,
        category: "send-messages",
        action: "send_email",
      },
    ]);

    const opened = await json("PUT", "/api/permissions", { sendMessages: true });
    expect(opened.body["permissions"]).toMatchObject({
      sendMessages: true,
      spendMoney: false,
      standingRules: ["Always sign emails as the Generic Corp team."],
    });
    await server.runtime.sendMessage({ text: "Now send it." });
    await server.runtime.cascade.drain();
    expect(results[1]).toContain("sent");
    expect(sent).toEqual([email]);

    const bad = await json("PUT", "/api/permissions", { shellHosts: ["http://evil"] });
    expect(bad.status).toBe(400);
    expect((await json("DELETE", "/api/permissions")).body["saved"]).toBe(false);
  });
});

describe("deciding a tool call", () => {
  const github = (toolName: string, input: unknown) => ({
    toolName: `mcp__github__${toolName}`,
    effects: ["mcp.read", "mcp.write", "external.write"],
    serverId: "github",
    serverToolName: toolName,
    input,
  });
  const permissions = parsePermissions({
    github: { repos: ["neill-k/generic-ai"], push: true, openPullRequests: true, merge: true },
  });

  it("keeps sending, spending and outside writes off by default, and reads on", () => {
    expect(
      decidePermission(DEFAULT_PERMISSIONS, { toolName: "pay", effects: ["payment.spend"] }),
    ).toMatchObject({ allowed: false, category: "spend-money" });
    expect(
      decidePermission(DEFAULT_PERMISSIONS, { toolName: "crm", effects: ["external.write"] }),
    ).toMatchObject({ allowed: false, category: "write-outside" });
    expect(
      decidePermission(DEFAULT_PERMISSIONS, { toolName: "web_fetch", effects: ["network.egress"] })
        .allowed,
    ).toBe(true);
    expect(
      decidePermission(
        { ...DEFAULT_PERMISSIONS, readOutside: false },
        { toolName: "web_fetch", effects: ["network.egress"] },
      ),
    ).toMatchObject({ allowed: false, category: "read-outside" });
    // The shell is governed by the network allowlist, not the read category.
    expect(
      decidePermission(
        { ...DEFAULT_PERMISSIONS, readOutside: false },
        { toolName: "bash", effects: ["process.spawn", "network.egress"] },
      ).allowed,
    ).toBe(true);
  });

  it("allows GitHub pushes and pull requests only in the repos the owner picked", () => {
    const push = github("push_files", { owner: "Neill-K", repo: "generic-ai", branch: "x" });
    expect(decidePermission(permissions, push)).toEqual({ allowed: true, category: "github" });
    expect(
      decidePermission(
        permissions,
        github("create_pull_request", { owner: "neill-k", repo: "generic-ai" }),
      ).allowed,
    ).toBe(true);
    expect(
      decidePermission(permissions, github("push_files", { owner: "evil", repo: "exfil" })),
    ).toMatchObject({
      allowed: false,
      reason: "the owner has not opened evil/exfil for agents to write to",
    });
    expect(decidePermission(permissions, github("push_files", {}))).toMatchObject({
      allowed: false,
      category: "github",
    });
    // Other GitHub writes (issues, comments) fall under writing to outside systems.
    expect(
      decidePermission(
        permissions,
        github("add_issue_comment", { owner: "neill-k", repo: "generic-ai" }),
      ),
    ).toMatchObject({ allowed: false, category: "write-outside" });
    const noPush = parsePermissions({ github: { push: false } }, permissions);
    expect(decidePermission(noPush, push)).toMatchObject({ allowed: false, category: "github" });
  });

  it("merges only with green checks confirmed", async () => {
    const refusals: RefusedActionInput[] = [];
    const log = {
      record: async (entry: RefusedActionInput) => {
        refusals.push(entry);
        return { ...entry, id: "1", at: "" };
      },
      list: async () => [],
    };
    let merged = 0;
    const merge = withAgentHarnessToolEffects(
      {
        name: "mcp__github__merge_pull_request",
        mcp: { serverId: "github", toolName: "merge_pull_request" },
        async execute() {
          merged += 1;
          return "merged";
        },
      },
      ["mcp.write", "external.write"],
    );
    const call = async (verifyGreenChecks?: () => Promise<boolean>) => {
      const bindings = gateToolsWithPermissions({ customTools: [merge] } as never, {
        permissions: () => permissions,
        refusals: log,
        agentId: "vp-engineering",
        ...(verifyGreenChecks === undefined ? {} : { verifyGreenChecks }),
      }) as unknown as { customTools: { execute: (...args: unknown[]) => Promise<unknown> }[] };
      return bindings.customTools[0]?.execute("call", {
        owner: "neill-k",
        repo: "generic-ai",
        pullNumber: 1,
      });
    };
    await expect(call()).rejects.toThrow(/nothing can confirm them yet/);
    await expect(call(async () => false)).rejects.toThrow(/checks are not all green/);
    expect(await call(async () => true)).toBe("merged");
    expect(merged).toBe(1);
    expect(refusals.map((entry) => entry.category)).toEqual(["github", "github"]);
  });

  it("checks what the owner and the company config may set", () => {
    expect(() => parsePermissions({ sendMessage: true })).toThrow(
      /Unknown permission "sendMessage"/,
    );
    expect(() => parsePermissions({ github: { repos: ["not a repo"] } })).toThrow(/owner\/name/);
    expect(() => parsePermissions({ spendMoney: "yes" })).toThrow(/true or false/);
    expect(parsePermissions({ shellHosts: ["PyPI.org", "", "pypi.org"] }).shellHosts).toEqual([
      "pypi.org",
    ]);
  });
});
