import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import {
  findSecretPlaceholders,
  isSecretGranted,
  SECRET_PLACEHOLDER_PATTERN,
  type SecretActorContext,
  type SecretsBinding,
  secretRedactionMarker,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";
import { createAgentHarness } from "./agent-harness.js";

// Obviously fake.
const FAKE_TOKEN = "fake-github-token-0000000000";

/** Minimal binding with the SDK contract's semantics; the real one lives in plugin-secrets. */
function fakeSecrets(values: Readonly<Record<string, string>>): SecretsBinding {
  const redactText = (text: string) => {
    let result = text;
    for (const [name, value] of Object.entries(values)) {
      result = result.split(value).join(secretRedactionMarker(name));
    }
    return result;
  };
  const redact = <T>(value: T): T => JSON.parse(redactText(JSON.stringify(value))) as T;
  return {
    kind: "secrets",
    prepare: async () => undefined,
    redact,
    redactText,
    grantedNames: async (grants) =>
      Object.keys(values).filter((name) => isSecretGranted(name, grants)),
    wrapTool<TTool>(tool: TTool, context: SecretActorContext): TTool {
      const original = tool as unknown as {
        execute: (id: string, params: { command: string }) => Promise<unknown>;
      };
      return {
        ...original,
        async execute(id: string, params: { command?: string }) {
          if (params.command === undefined) {
            return redact(await original.execute(id, params as { command: string }));
          }
          for (const name of findSecretPlaceholders(params.command)) {
            const allowed = isSecretGranted(name, context.grants);
            await context.onAccess?.({
              name,
              actorId: context.actorId,
              purpose: "tool-input",
              decision: allowed ? "allowed" : "denied",
              reason: allowed ? "granted" : "not granted",
              at: new Date().toISOString(),
              ...(context.runId === undefined ? {} : { runId: context.runId }),
            });
            if (!allowed) {
              throw new Error(`Secret "${name}" is not granted to "${context.actorId}".`);
            }
          }
          const command = params.command.replace(
            SECRET_PLACEHOLDER_PATTERN,
            (_match, name: string) => values[name] ?? "",
          );
          return redact(await original.execute(id, { command }));
        },
      } as unknown as TTool;
    },
  };
}

function promptText(context: Context): string {
  const user = context.messages.find((message) => message.role === "user");
  const text =
    user === undefined
      ? ""
      : typeof user.content === "string"
        ? user.content
        : user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return `${context.systemPrompt ?? ""}\n${text}`;
}

function lastToolResult(context: Context): { text: string; isError: boolean } | undefined {
  const last = context.messages.at(-1);
  if (last?.role !== "toolResult") {
    return undefined;
  }
  return {
    text: last.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    isError: last.isError,
  };
}

function call(name: string, args: JsonObject): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

describe("agent harness secrets", () => {
  it("resolves granted placeholders per role, scrubs results and events, and audits use", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-secrets-"));
    const commands: string[] = [];
    const prompts: Record<string, string> = {};
    const toolResults: { text: string; isError: boolean }[] = [];
    const command = "git push https://x:{{secret:GITHUB_TOKEN}}@example.test";

    const provider = registerFauxProvider({ models: [{ id: "test-model" }] });
    registrations.push(provider);
    const record = (context: Context) => {
      const result = lastToolResult(context);
      if (result !== undefined) {
        toolResults.push(result);
      }
    };
    provider.setResponses([
      (context) => {
        prompts["root"] = promptText(context);
        return call("delegate_agent", { roleId: "builder", task: "push" });
      },
      (context) => {
        prompts["builder"] = promptText(context);
        return call("bash", { command });
      },
      (context) => {
        record(context);
        return call(STOP_AND_RESPOND_TOOL_NAME, { response: "pushed" });
      },
      () => call("delegate_agent", { roleId: "reviewer", task: "check" }),
      (context) => {
        prompts["reviewer"] = promptText(context);
        return call("bash", { command });
      },
      (context) => {
        record(context);
        return call(STOP_AND_RESPOND_TOOL_NAME, { response: "checked" });
      },
      () => call(STOP_AND_RESPOND_TOOL_NAME, { response: "root done" }),
    ]);
    const model = provider.getModel("test-model") as Model;

    const harness = createAgentHarness(
      {
        id: "secrets-harness",
        adapter: "native",
        model: "faux/test-model",
        roles: [
          { id: "builder", kind: "builder", secrets: ["GITHUB_*"] },
          { id: "reviewer", kind: "builder" },
        ],
      },
      { native: { resolveModel: () => model } },
    );

    const result = await harness.run({
      instruction: "Push the branch.",
      workspaceRoot: root,
      capabilities: {
        terminalTools: {
          tool: withAgentHarnessToolEffects(
            {
              name: "bash",
              label: "bash",
              description: "terminal",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
              execute: async (_id: string, params: { command: string }) => {
                commands.push(params.command);
                return {
                  content: [{ type: "text" as const, text: `ran: ${params.command}` }],
                  details: {},
                };
              },
            },
            ["process.spawn", "fs.read", "fs.write"],
          ),
        },
        secrets: fakeSecrets({ GITHUB_TOKEN: FAKE_TOKEN }),
      },
    });

    expect(result.failureMessage).toBeUndefined();
    expect(result.status).toBe("succeeded");
    // The builder's command ran with the real value; the reviewer, without the grant, was refused before running.
    expect(commands).toEqual([`git push https://x:${FAKE_TOKEN}@example.test`]);
    expect(toolResults[1]?.isError).toBe(true);
    expect(toolResults[1]?.text).toMatch(/not granted to "reviewer"/);
    // Nothing the model or the event log sees holds the value.
    expect(toolResults[0]?.isError).toBe(false);
    expect(JSON.stringify(toolResults)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(toolResults)).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(JSON.stringify(result.events)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(result.policyDecisions)).not.toContain(FAKE_TOKEN);
    // Only the granted role is told about the secret, by name.
    expect(prompts["builder"]).toContain("Available secrets: GITHUB_TOKEN.");
    expect(prompts["root"]).not.toContain("Available secrets");
    expect(prompts["reviewer"]).not.toContain("Available secrets");
    // Each use is audited as a policy decision.
    expect(result.policyDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: "builder", action: "secret.read", decision: "allowed" }),
        expect.objectContaining({ actorId: "reviewer", action: "secret.read", decision: "denied" }),
      ]),
    );
    expect(
      result.events.some(
        (event) =>
          event.name === "policy.decision" &&
          (event.data as { action?: string }).action === "secret.read",
      ),
    ).toBe(true);
  });
});
