import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentLifecycleHookExecutor } from "../../src/harness/lifecycle-hooks.js";

const SERVER_SECRET = "sk-hook-env-test-server-secret";
const printEnv =
  "console.log(JSON.stringify({decision:'append_context',additionalContext:JSON.stringify(process.env)}))";

async function hookEnv(handler: Record<string, unknown>): Promise<Record<string, string>> {
  const executor = createAgentLifecycleHookExecutor({
    schemaVersion: "v1",
    hooks: [
      {
        id: "print-env",
        events: ["UserPromptSubmit"],
        handler: { type: "command", command: process.execPath, args: ["-e", printEnv], ...handler },
      },
    ],
  } as never);
  const result = await executor.run({ event: "UserPromptSubmit", runId: "run", scopeId: "scope" });
  const context = result.decisions[0]?.additionalContext;
  if (context === undefined) {
    throw new Error(`hook produced no context: ${JSON.stringify(result.decisions)}`);
  }
  return JSON.parse(context) as Record<string, string>;
}

describe("command lifecycle hooks get a clean environment", () => {
  beforeEach(() => {
    process.env["GENERIC_AI_HOOK_TEST_PROVIDER_KEY"] = SERVER_SECRET;
  });
  afterEach(() => {
    delete process.env["GENERIC_AI_HOOK_TEST_PROVIDER_KEY"];
  });

  it("does not hand the server's environment to hook commands", async () => {
    const env = await hookEnv({});
    expect(JSON.stringify(env)).not.toContain(SERVER_SECRET);
    expect(env["PATH"]).toBeTruthy();
  });

  it("passes variables the hook declares, and server variables it names in passEnv", async () => {
    const env = await hookEnv({
      env: { HOOK_SETTING: "on" },
      passEnv: ["GENERIC_AI_HOOK_TEST_PROVIDER_KEY"],
    });
    expect(env["HOOK_SETTING"]).toBe("on");
    expect(env["GENERIC_AI_HOOK_TEST_PROVIDER_KEY"]).toBe(SERVER_SECRET);
  });
});
