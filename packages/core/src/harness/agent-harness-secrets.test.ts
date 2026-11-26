import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import {
  findSecretPlaceholders,
  isSecretGranted,
  SECRET_PLACEHOLDER_PATTERN,
  type SecretActorContext,
  type SecretsBinding,
  secretRedactionMarker,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

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

type FakeTool = { readonly name?: string; readonly execute?: unknown };

async function callTool(tools: readonly FakeTool[] | undefined, name: string, params: unknown) {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (tool === undefined || typeof tool.execute !== "function") {
    throw new Error(`Expected tool ${name}.`);
  }
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    `${name}-call`,
    params,
    undefined,
    undefined,
    {} as never,
  );
}

describe("agent harness secrets", () => {
  it("resolves granted placeholders per role, scrubs results and events, and audits use", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-harness-secrets-"));
    const commands: string[] = [];
    const prompts: string[] = [];
    const toolResults: unknown[] = [];
    let explorerError: string | undefined;
    let sessionIndex = 0;

    const harness = createAgentHarness(
      {
        id: "secrets-harness",
        adapter: "pi",
        model: "fake-model",
        roles: [
          { id: "builder", kind: "builder", secrets: ["GITHUB_*"] },
          { id: "verifier", kind: "verifier" },
        ],
      },
      {
        sessionInputs: {
          agentDir: root,
          authStorage: {} as never,
          modelRegistry: {} as never,
          model: {} as never,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory(),
        },
        factories: {
          createAgentSession: async (options) => {
            if (options === undefined) {
              throw new Error("Expected createAgentSession options.");
            }
            const sessionId = `session-${++sessionIndex}`;
            const tools = options.customTools as readonly FakeTool[] | undefined;
            return {
              session: {
                sessionId,
                messages: [],
                subscribe: () => () => undefined,
                async prompt(prompt: string) {
                  prompts.push(prompt);
                  if (prompt.includes("root coordinator")) {
                    await callTool(tools, "delegate_agent", { roleId: "builder", task: "push" });
                    await callTool(tools, "delegate_agent", { roleId: "verifier", task: "check" });
                    await callTool(tools, STOP_AND_RESPOND_TOOL_NAME, { response: "root done" });
                    return;
                  }
                  const command = "git push https://x:{{secret:GITHUB_TOKEN}}@example.test";
                  if (prompt.includes('role "builder"')) {
                    toolResults.push(await callTool(tools, "bash", { command }));
                    await callTool(tools, STOP_AND_RESPOND_TOOL_NAME, { response: "pushed" });
                  } else {
                    explorerError = await callTool(tools, "bash", { command }).then(
                      () => undefined,
                      (error: unknown) => (error as Error).message,
                    );
                    await callTool(tools, STOP_AND_RESPOND_TOOL_NAME, { response: "checked" });
                  }
                },
              },
            } as never;
          },
        },
      },
    );

    const result = await harness.run({
      instruction: "Push the branch.",
      workspaceRoot: root,
      capabilities: {
        terminalTools: {
          tool: withAgentHarnessToolEffects(
            {
              name: "bash",
              description: "terminal",
              execute: async (_id: string, params: { command: string }) => {
                commands.push(params.command);
                return { content: [{ type: "text", text: `ran: ${params.command}` }] };
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
    // The builder's command ran with the real value; the verifier was refused before running.
    expect(commands).toEqual([`git push https://x:${FAKE_TOKEN}@example.test`]);
    expect(explorerError).toMatch(/not granted to "verifier"/);
    // Nothing the model or the event log sees holds the value.
    expect(JSON.stringify(toolResults)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(toolResults)).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(JSON.stringify(result.events)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(result.policyDecisions)).not.toContain(FAKE_TOKEN);
    // Only the granted role is told about the secret, by name.
    expect(prompts.find((prompt) => prompt.includes('role "builder"'))).toContain(
      "Available secrets: GITHUB_TOKEN.",
    );
    expect(prompts.find((prompt) => prompt.includes("root coordinator"))).not.toContain(
      "Available secrets",
    );
    // Each use is audited as a policy decision.
    expect(result.policyDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: "builder", action: "secret.read", decision: "allowed" }),
        expect.objectContaining({ actorId: "verifier", action: "secret.read", decision: "denied" }),
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
