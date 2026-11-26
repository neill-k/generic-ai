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
import { type ApprovalRequest, withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createGenericCorpServer } from "./server.js";
import { createCompanyToolkit } from "./toolkit.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("owner approvals in Generic Corp", () => {
  it("parks an outward action until the owner approves it, then sends it once", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-approvals-"));
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
      name: "Approval Corp",
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
    const gatedResults: string[] = [];
    provider.setResponses([
      // Turn 1: try to send; the gate holds the call.
      () => fauxAssistantMessage([fauxToolCall("send_email", email)], { stopReason: "toolUse" }),
      (context) => {
        const last = context.messages.at(-1);
        gatedResults.push(last?.role === "toolResult" ? JSON.stringify(last.content) : "");
        return fauxAssistantMessage(
          [fauxToolCall("stop_and_respond", { response: "Waiting for the owner to approve." })],
          { stopReason: "toolUse" },
        );
      },
      // Turn 2, after approval: repeat the identical call, which now runs.
      () => fauxAssistantMessage([fauxToolCall("send_email", email)], { stopReason: "toolUse" }),
      () =>
        fauxAssistantMessage([fauxToolCall("stop_and_respond", { response: "Email sent." })], {
          stopReason: "toolUse",
        }),
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

    const { task } = await server.runtime.sendMessage({ text: "Tell the customer it shipped." });
    await server.runtime.cascade.drain();

    expect(sent).toEqual([]);
    expect(gatedResults[0]).toMatch(/approv/i);
    expect((await server.runtime.cascade.get(task.taskId))?.status).toBe("waiting");

    const listed = await server.fetch(new Request("http://127.0.0.1/api/approvals?status=pending"));
    expect(listed.status).toBe(200);
    const { approvals } = (await listed.json()) as { approvals: ApprovalRequest[] };
    expect(approvals).toHaveLength(1);
    const [request] = approvals;
    expect(request?.action.name).toBe("send_email");
    expect(request?.action.input).toEqual(email);
    expect(request?.requester).toMatchObject({ agentId: "ceo", taskId: task.taskId });

    const approved = await server.fetch(
      new Request(`http://127.0.0.1/api/approvals/${request?.approvalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: "Go ahead." }),
      }),
    );
    expect(approved.status).toBe(200);
    await server.runtime.cascade.drain();

    const settled = await server.runtime.cascade.get(task.taskId);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.outputText).toBe("Email sent.");
    expect(sent).toEqual([email]);
  });
});
