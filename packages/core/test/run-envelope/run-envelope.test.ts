import { describe, expect, it } from "vitest";
import type { OutputFinalizeInput } from "../../../sdk/src/contracts/output.js";
import { createRunEnvelope, finalizeRunEnvelope } from "../../src/run-envelope/index.js";

describe("run-envelope helpers", () => {
  it("creates a stable frozen envelope and delegates output shaping to the plugin", async () => {
    const envelope = createRunEnvelope({
      runId: "run-001",
      rootScopeId: "scope-001",
      rootAgentId: "agent-001",
      mode: "async",
      eventStream: {
        kind: "event-stream-reference",
        streamId: "events-001",
      },
    });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.timestamps)).toBe(true);
    expect(envelope.status).toBe("created");

    const finalized = await finalizeRunEnvelope({
      envelope,
      run: {
        message: "hello from the run",
      },
      status: "succeeded",
      outputPlugin: {
        kind: "output-plugin",
        manifest: {
          kind: "plugin",
          id: "sample-output",
          name: "Sample Output",
        },
        contentType: "application/json",
        async finalize(input: OutputFinalizeInput<{ readonly message: string }>) {
          return {
            kind: "output-envelope",
            pluginId: input.pluginId,
            contentType: "application/json",
            payload: {
              message: input.run.message,
              scopeId: input.scopeId,
            },
            summary: "done",
          };
        },
      },
    });

    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.timestamps)).toBe(true);
    expect(finalized.status).toBe("succeeded");
    expect(finalized.outputPluginId).toBe("sample-output");
    expect(finalized.output?.payload).toEqual({
      message: "hello from the run",
      scopeId: "scope-001",
    });
  });
});
