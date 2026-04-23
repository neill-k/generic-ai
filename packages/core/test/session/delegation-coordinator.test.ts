import { describe, expect, it } from "vitest";

import { createDelegationCoordinator, SessionOrchestrator } from "../../src/session/index.js";

describe("createDelegationCoordinator", () => {
  it("delegates work through child sessions while the kernel orchestrator owns lifecycle", async () => {
    const orchestrator = new SessionOrchestrator({
      now: (() => {
        let timestamp = 100;
        return () => ++timestamp;
      })(),
      idFactory: (() => {
        let counter = 0;
        return () => `session-${++counter}`;
      })(),
    });
    const coordinator = createDelegationCoordinator({ orchestrator });
    const root = coordinator.createRootSession({ agentId: "coordinator" });

    const delegated = await coordinator.delegate(
      root.id,
      {
        agentId: "implementer",
        task: {
          prompt: "Summarize the stack",
        },
      },
      async (request) => ({
        summary: `Handled by ${request.agentId}`,
      }),
    );

    expect(coordinator.kind).toBe("delegation");
    expect(delegated.sessionId).toBe("session-2");
    expect(delegated.rootSessionId).toBe(root.id);
    expect(delegated.status).toBe("succeeded");
    expect(delegated.result).toEqual({
      summary: "Handled by implementer",
    });
    expect(coordinator.list(root.id)).toEqual([delegated]);
  });

  it("maps abort-style failures to cancelled child sessions", async () => {
    const coordinator = createDelegationCoordinator();
    const root = coordinator.createRootSession();

    const result = await coordinator.delegate(
      root.id,
      {
        agentId: "reviewer",
        task: "stop",
      },
      () => {
        const error = new Error("halt");
        error.name = "AbortError";
        throw error;
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.cancellationReason).toBe("halt");
  });
});
