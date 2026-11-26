import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import type { GateCommandResult } from "@generic-ai/autonomy";
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
  const registration = registerFauxProvider({ models: [{ id: "long-run" }] });
  registrations.push(registration);
  return registration;
}

function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === "user");
  if (user === undefined) {
    return "";
  }
  return typeof user.content === "string"
    ? user.content
    : user.content.map((block) => ("text" in block ? block.text : "")).join("");
}

const ok: GateCommandResult = {
  status: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};

describe("native session goals and autonomous mode", () => {
  it("continues a goal across turns until the agent completes it", async () => {
    const faux = provider();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(lastUserText(context));
        return fauxAssistantMessage("Step one done.");
      },
      (context) => {
        prompts.push(lastUserText(context));
        return fauxAssistantMessage(fauxToolCall("complete_goal", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("All done."),
    ]);
    const manager = SessionManager.inMemory("/tmp/work");

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Build the thing.",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
      goal: { objective: "Build the thing and test it" },
    });

    expect(result.failureMessage).toBeUndefined();
    expect(prompts[0]).toBe("Build the thing.");
    expect(prompts[1]).toContain("[goal: continuation]");
    expect(prompts[1]).toContain("<objective>\nBuild the thing and test it\n</objective>");
    expect(result.goal).toMatchObject({ status: "complete", continuationsUsed: 1 });
    expect(result.outputText).toBe("All done.");
    expect(result.events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "plugin.generic-ai-runtime.native.long_run_continuation",
        "plugin.generic-ai-runtime.native.long_run_stopped",
      ]),
    );
    const saved = manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "thread_goal_state");
    expect(saved.length).toBeGreaterThan(1);
  });

  it("refuses a completion claim that fails the host's check", async () => {
    const faux = provider();
    let checks = 0;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("complete_goal", {}), { stopReason: "toolUse" }),
      (context) => {
        expect(JSON.stringify(context.messages.at(-1))).toContain("report.md is missing");
        return fauxAssistantMessage("Writing the report.");
      },
      fauxAssistantMessage(fauxToolCall("complete_goal", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Write the report.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      goal: {
        objective: "Write report.md",
        verify: () => {
          checks += 1;
          return checks === 1
            ? { passed: false, feedback: "report.md is missing" }
            : { passed: true };
        },
      },
    });

    expect(checks).toBe(2);
    expect(result.goal?.status).toBe("complete");
  });

  it("sends a completed stop back while the quality gates fail", async () => {
    const faux = provider();
    const prompts: string[] = [];
    const stop = (response: string) =>
      fauxAssistantMessage(fauxToolCall("stop_and_respond", { response }), {
        stopReason: "toolUse",
      });
    faux.setResponses([
      stop("Done, I think."),
      (context) => {
        prompts.push(lastUserText(context));
        return stop("Fixed and done.");
      },
    ]);
    const gateResults: GateCommandResult[] = [{ ...ok, status: 1, stdout: "2 tests failed" }, ok];

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Fix the tests.",
      compaction: false,
      retry: false,
      autonomous: {
        gates: { commands: ["npm test"] },
        gateRunner: { runGate: async () => gateResults.shift() ?? ok },
      },
    });

    expect(prompts[0]).toContain("[autonomous-continuation: gate-failed]");
    expect(prompts[0]).toContain("`npm test` exited with code 1");
    expect(prompts[0]).toContain("2 tests failed");
    expect(result.outputText).toBe("Fixed and done.");
    expect(result.autonomous).toMatchObject({
      continuationsUsed: 1,
      gateAttempts: { "npm test": 0 },
    });
  });

  it("continues a goal saved in a resumed session", async () => {
    const faux = provider();
    const manager = SessionManager.inMemory("/tmp/work");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("create_goal", { objective: "Long task" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Working."),
      fauxAssistantMessage(fauxToolCall("complete_goal", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished."),
    ]);
    const first = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Start a goal.",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
      goal: { waitForBackoff: false },
    });
    expect(first.goal?.status).toBe("complete");
    expect(first.goal?.objective).toBe("Long task");
    expect(first.goal?.continuationsUsed).toBe(1);

    faux.setResponses([fauxAssistantMessage("Nothing to do.")]);
    const resumed = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Anything left?",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
      goal: true,
    });
    expect(resumed.goal).toMatchObject({ status: "complete", objective: "Long task" });
  });
});
