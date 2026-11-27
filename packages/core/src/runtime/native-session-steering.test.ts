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

function userTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => ("text" in block ? block.text : "")).join(""),
    );
}

describe("native session steering", () => {
  it("hands a message that arrives mid-turn to the agent at its next step", async () => {
    const registration = registerFauxProvider({ models: [{ id: "steering" }] });
    registrations.push(registration);
    const inbox: string[] = [];
    let polls = 0;
    let seen: string[] = [];
    registration.setResponses([
      () => {
        // The owner writes while the agent is mid-step.
        inbox.push("Use the Austin venue, not Dallas.");
        return fauxAssistantMessage(fauxToolCall("missing_tool", {}), { stopReason: "toolUse" });
      },
      (context) => {
        seen = userTexts(context);
        return fauxAssistantMessage("Booking Austin.");
      },
    ]);

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: registration.getModel(),
      capabilities: {},
      prompt: "Book the offsite venue.",
      turnMode: "single-turn",
      sessionManager: SessionManager.inMemory("/tmp/work"),
      compaction: false,
      retry: false,
      steering: () => {
        polls += 1;
        return inbox.splice(0);
      },
    });

    expect(result.failureMessage).toBeUndefined();
    expect(result.outputText).toBe("Booking Austin.");
    expect(seen.at(-1)).toBe("Use the Austin venue, not Dallas.");
    // Delivered once, though the source was polled more than once.
    expect(seen.filter((text) => text.includes("Austin venue"))).toHaveLength(1);
    expect(polls).toBeGreaterThan(0);
  });
});
