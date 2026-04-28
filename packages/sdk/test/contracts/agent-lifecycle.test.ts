import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_LIFECYCLE_HOOK_EVENTS,
  type AgentLifecycleHookContext,
  type AgentLifecycleHookDecisionRecord,
  type AgentLifecycleHooksConfig,
  type AgentLifecycleInProcessHookHandler,
} from "../../src/contracts/agent-lifecycle.js";

describe("agent lifecycle hook contracts", () => {
  it("defines the first-pass lifecycle event set and handler contracts", async () => {
    expect(AGENT_LIFECYCLE_HOOK_EVENTS).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
    ]);

    const config: AgentLifecycleHooksConfig = {
      schemaVersion: "v1",
      defaults: {
        timeoutMs: 5000,
        failureMode: "fail-closed",
      },
      hooks: [
        {
          id: "guard-terminal",
          events: ["PreToolUse", "PostToolUse"],
          matcher: {
            toolName: "bash",
          },
          handler: {
            type: "command",
            command: "node",
            args: ["./hooks/guard-terminal.mjs"],
          },
        },
      ],
    };

    const handler: AgentLifecycleInProcessHookHandler = {
      id: "context-injector",
      async handle(context) {
        return {
          decision: context.event === "UserPromptSubmit" ? "append_context" : "allow",
          additionalContext: "Prefer reproducible commands.",
        };
      },
    };
    const decision: AgentLifecycleHookDecisionRecord = {
      id: "decision-1",
      hookId: "guard-terminal",
      event: "PreToolUse",
      handlerType: "command",
      status: "blocked",
      decision: "block",
      startedAt: "2026-04-28T00:00:00.000Z",
      completedAt: "2026-04-28T00:00:00.010Z",
      reason: "Command is outside workspace policy.",
    };

    expect(config.hooks[0]?.events).toEqual(["PreToolUse", "PostToolUse"]);
    await expect(
      handler.handle({
        event: "UserPromptSubmit",
        runId: "run-1",
        scopeId: "scope-1",
        prompt: "Ship it.",
      }),
    ).resolves.toMatchObject({ decision: "append_context" });
    expect(decision.status).toBe("blocked");
    expectTypeOf<AgentLifecycleHookContext>().toMatchTypeOf<{
      readonly event: (typeof AGENT_LIFECYCLE_HOOK_EVENTS)[number];
      readonly runId: string;
      readonly scopeId: string;
    }>();
  });
});
