import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  loadHarnessState,
  REFINEMENT_SYSTEM_PROMPT,
} from "@generic-ai/continual";
import { afterEach, describe, expect, it } from "vitest";

import { runCapabilityNativeAgentSession } from "./native-session.js";

const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function provider() {
  const registration = registerFauxProvider({ models: [{ id: "continual" }] });
  registrations.push(registration);
  return registration;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "native-continual-"));
  dirs.push(dir);
  return dir;
}

const proposal = (edits: unknown[]) =>
  JSON.stringify({
    summary: "Captured the CI retry tactic",
    rationale: "The flaky test failed twice and passed on retry",
    expectedOutcome: "Less time lost to flaky CI",
    edits,
  });

describe("native session continual harness", () => {
  it("refines from a refine tool call and shows the entry to the next session", async () => {
    const faux = provider();
    const cwd = tempDir();
    const globalDir = join(tempDir(), "global");
    const localDir = join(tempDir(), "local");
    let plannerPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("refine", { instructions: "remember to retry the flaky test once" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Noted."),
      (context: Context) => {
        expect(context.systemPrompt).toBe(REFINEMENT_SYSTEM_PROMPT);
        const message = context.messages[0];
        plannerPrompt = typeof message?.content === "string" ? message.content : "";
        return fauxAssistantMessage(
          proposal([
            {
              action: "create",
              kind: "memory",
              title: "Flaky CI test",
              content: "Retry test_upload once before investigating.",
            },
          ]),
        );
      },
    ]);
    const continual = { globalDir, localDir, autoRefine: false as const };
    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: {} as never,
      prompt: "The upload test failed again, then passed on retry.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      continual,
    });

    expect(result.failureMessage).toBeUndefined();
    expect(plannerPrompt).toContain(
      "<user_refine_instructions>\nremember to retry the flaky test once",
    );
    expect(plannerPrompt).toContain("The upload test failed again");
    expect(result.refinements).toHaveLength(1);
    expect(result.refinements?.[0]?.scope).toBe("local");
    const local = await loadHarnessState(localDir, "local");
    expect(local.entries.memory["flaky_ci_test"]?.content).toBe(
      "Retry test_upload once before investigating.",
    );
    const refined = result.events.filter((event) => event.name.endsWith("native.harness_refined"));
    expect(refined).toHaveLength(1);
    expect(refined[0]?.data).toMatchObject({ source: "user", scope: "local", applied: 1 });
    const notice = result.messages.find(
      (message) => (message as { customType?: string }).customType === "refinement_notice",
    ) as { content: string } | undefined;
    expect(notice?.content).toContain("[user-refinement]");
    expect(notice?.content).toContain("[local:flaky_ci_test] Flaky CI test");

    let nextSystemPrompt = "";
    faux.setResponses([
      (context: Context) => {
        nextSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("Will retry.");
      },
    ]);
    await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: {} as never,
      prompt: "Run the upload tests.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      continual,
    });
    expect(nextSystemPrompt).toContain("# Continual Harness State");
    expect(nextSystemPrompt).toContain(
      "- [local:flaky_ci_test] Flaky CI test (general, v1): Retry test_upload once before investigating.",
    );
    expect(nextSystemPrompt).toContain("- refine:");
  });

  it("handles /refine --global and /refine rollback without a model turn", async () => {
    const faux = provider();
    const cwd = tempDir();
    const globalDir = join(tempDir(), "global");
    faux.setResponses([
      fauxAssistantMessage(
        proposal([
          {
            action: "create",
            kind: "memory",
            id: "pkg",
            title: "Package manager",
            content: "Use npm.",
          },
        ]),
      ),
    ]);
    const base = {
      cwd,
      model: faux.getModel(),
      capabilities: {} as never,
      compaction: false as const,
      retry: false as const,
      continual: { globalDir, autoRefine: false as const },
    };
    const refined = await runCapabilityNativeAgentSession({
      ...base,
      prompt: "/refine --global the user prefers npm",
    });
    expect(refined.failureMessage).toBeUndefined();
    expect(refined.outputText).toContain("- create memory [global:pkg] Package manager: Use npm.");
    expect((await loadHarnessState(globalDir, "global")).entries.memory["pkg"]).toBeDefined();
    const id = refined.refinements?.[0]?.id as string;

    const rolledBack = await runCapabilityNativeAgentSession({
      ...base,
      prompt: `/refine rollback ${id}`,
    });
    expect(rolledBack.failureMessage).toBeUndefined();
    expect(rolledBack.refinements?.[0]?.rollbackOf).toBe(id);
    expect((await loadHarnessState(globalDir, "global")).entries.memory["pkg"]).toBeUndefined();

    const local = await runCapabilityNativeAgentSession({ ...base, prompt: "/refine note this" });
    expect(local.failureMessage).toContain("requires a persisted session");
  });

  it("runs the automatic review and skips refinement when it declines", async () => {
    const faux = provider();
    const cwd = tempDir();
    let reviewed = false;
    faux.setResponses([
      fauxAssistantMessage("Done."),
      (context: Context) => {
        expect(context.systemPrompt).toBe(AUTO_REFINE_REVIEW_SYSTEM_PROMPT);
        reviewed = true;
        return fauxAssistantMessage('{"shouldRefine":false,"rationale":"one-off"}');
      },
    ]);
    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: {} as never,
      prompt: "Say done.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      continual: {
        globalDir: join(tempDir(), "global"),
        localDir: join(tempDir(), "local"),
        autoRefine: { turnInterval: 1, cooldownMs: 0 },
      },
    });
    expect(result.failureMessage).toBeUndefined();
    expect(reviewed).toBe(true);
    expect(result.refinements).toBeUndefined();
  });
});
