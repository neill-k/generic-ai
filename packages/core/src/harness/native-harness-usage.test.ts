import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type FauxProviderRegistration,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import type { AgentHarnessBudget, UsageRecordedEventData } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { STOP_AND_RESPOND_TOOL_NAME } from "../runtime/index.js";
import { createAgentHarness } from "./agent-harness.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function fauxModels(): {
  provider: FauxProviderRegistration;
  resolveModel: (ref: string) => Model;
} {
  const provider = registerFauxProvider({
    models: [{ id: "root-model" }, { id: "builder-model" }],
  });
  registrations.push(provider);
  return {
    provider,
    resolveModel: (ref) => {
      const id = ref.split("/").at(-1) ?? ref;
      const model = provider.getModel(id);
      if (model === undefined) {
        throw new Error(`unknown test model ${ref}`);
      }
      return model;
    },
  };
}

function stop(response: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(STOP_AND_RESPOND_TOOL_NAME, { response })], {
    stopReason: "toolUse",
  });
}

const delegate = fauxAssistantMessage(
  [fauxToolCall("delegate_agent", { roleId: "builder", task: "Build it." })],
  { stopReason: "toolUse" },
);

const harnessConfig = {
  id: "native-usage",
  adapter: "native" as const,
  model: "faux/root-model",
  policyProfile: "local-dev-full" as const,
  roles: [
    { id: "root", kind: "root" as const, description: "Coordinates the work." },
    {
      id: "builder",
      kind: "builder" as const,
      description: "Builds things.",
      model: "faux/builder-model",
    },
  ],
};

/**
 * Wrap responses so the test sees which model served each request that was still live. Once a run
 * is stopped, the agent loop may still open one more request with an aborted signal; a real provider
 * rejects it before any tokens are spent, so those are not counted as served.
 */
function served(responses: readonly AssistantMessage[], log: string[]): FauxResponseStep[] {
  return responses.map((response) => (_context, options, _state, model) => {
    if (options?.signal?.aborted !== true) {
      log.push(model.id);
    }
    return response;
  });
}

async function runDelegation(input: {
  readonly workspaceRoot: string;
  readonly responses: readonly AssistantMessage[];
  readonly budget?: AgentHarnessBudget;
}) {
  const { provider, resolveModel } = fauxModels();
  const calls: string[] = [];
  provider.setResponses(served(input.responses, calls));
  const harness = createAgentHarness(harnessConfig, { native: { resolveModel, retry: false } });
  const result = await harness.run({
    instruction: "Build the thing",
    workspaceRoot: input.workspaceRoot,
    artifactDir: join(input.workspaceRoot, "artifacts"),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  });
  return { result, calls };
}

describe("native harness usage and budgets", () => {
  it("records usage for every response and rolls it up per role and model", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-usage-"));
    const { result } = await runDelegation({
      workspaceRoot,
      responses: [delegate, stop("Builder finished."), stop("All done.")],
    });

    expect(result.status).toBe("succeeded");
    const recorded = result.events.filter((event) => event.name === "usage.recorded");
    expect(recorded).toHaveLength(3);
    expect(recorded.map((event) => (event.data as UsageRecordedEventData).roleId)).toEqual([
      "root",
      "builder",
      "root",
    ]);
    expect(recorded.map((event) => (event.data as UsageRecordedEventData).model)).toEqual([
      "root-model",
      "builder-model",
      "root-model",
    ]);

    const usage = result.usage;
    expect(usage?.totals.responses).toBe(3);
    expect(usage?.totals.totalTokens).toBeGreaterThan(0);
    expect(usage?.byAgent.map((entry) => [entry.roleId, entry.totals.responses])).toEqual(
      expect.arrayContaining([
        ["root", 2],
        ["builder", 1],
      ]),
    );
    expect(usage?.byModel.map((entry) => entry.model)).toEqual(["builder-model", "root-model"]);
    expect(result.errorCategory).toBeUndefined();
  });

  it("stops the run with budget_exceeded when the token cap is reached", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-usage-"));
    const { result, calls } = await runDelegation({
      workspaceRoot,
      responses: [delegate, stop("Builder finished."), stop("All done.")],
      budget: { maxTokens: 1 },
    });

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("budget_exceeded");
    expect(result.failureMessage).toMatch(/token budget reached/);
    // The first response reached the cap: the delegation never ran.
    expect(calls).toEqual(["root-model"]);
    const names = result.events.map((event) => event.name);
    expect(names.filter((name) => name === "usage.budget.exceeded")).toHaveLength(1);
    expect(names).not.toContain("handoff.requested");
  });

  it("stops the whole run when a delegated role reaches the cap", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-usage-"));
    const responses = [delegate, stop("Builder finished."), stop("All done.")];
    // Measure the coordinator's first response, then allow exactly that much plus one token.
    const probe = await runDelegation({ workspaceRoot, responses });
    const first = probe.result.events.find((event) => event.name === "usage.recorded");
    const firstTokens = (first?.data as UsageRecordedEventData).usage.totalTokens;

    const { result, calls } = await runDelegation({
      workspaceRoot,
      responses,
      budget: { maxTokens: firstTokens + 1 },
    });

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("budget_exceeded");
    // Coordinator, then the builder's response that crossed the cap; the coordinator never resumes.
    expect(calls).toEqual(["root-model", "builder-model"]);
    const exceeded = result.events.find((event) => event.name === "usage.budget.exceeded");
    expect(exceeded?.data).toMatchObject({ breaches: [{ limit: "tokens" }] });
    expect(result.events.map((event) => event.name)).toContain("handoff.failed");
  });

  it("never retries a response that reached the budget", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "generic-ai-native-usage-"));
    const { provider, resolveModel } = fauxModels();
    provider.setResponses([
      fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage: "overloaded" }),
      stop("Recovered."),
    ]);
    const harness = createAgentHarness(
      { id: "native-usage-retry", adapter: "native", model: "faux/root-model" },
      {
        native: { resolveModel, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
      },
    );
    const result = await harness.run({
      instruction: "Anything",
      workspaceRoot,
      artifactDir: join(workspaceRoot, "artifacts"),
      budget: { maxTokens: 1 },
    });

    expect(result.errorCategory).toBe("budget_exceeded");
    // The transient error would normally be retried; the budget stop wins and no request follows.
    expect(provider.state.callCount).toBe(1);
    expect(result.outputText).not.toBe("Recovered.");
  });
});
