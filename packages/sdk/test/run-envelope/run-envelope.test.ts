import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  RunEnvelope,
  RunEnvelopeFinalizationInput,
  RunEnvelopeMode,
  RunEnvelopeStatus,
  RunEnvelopeTerminalStatus,
} from "../../src/run-envelope/index.js";

describe("@generic-ai/sdk run-envelope contracts", () => {
  it("exposes a minimal frozen envelope shape and explicit output-plugin boundary", () => {
    const sampleEnvelope: RunEnvelope = {
      kind: "run-envelope",
      runId: "run-001",
      rootScopeId: "scope-001",
      rootAgentId: "agent-001",
      mode: "sync",
      status: "created",
      timestamps: {
        createdAt: "2026-04-13T00:00:00.000Z",
      },
      eventStream: {
        kind: "event-stream-reference",
        streamId: "events-001",
      },
    };

    const sampleFinalizeInput: RunEnvelopeFinalizationInput<{ readonly message: string }, { readonly text: string }> = {
      envelope: sampleEnvelope,
      outputPlugin: {
        kind: "output-plugin",
        manifest: {
          kind: "plugin",
          id: "sample-output",
          name: "Sample Output",
        },
        contentType: "text/plain",
        async finalize(input) {
          return {
            kind: "output-envelope",
            pluginId: input.pluginId,
            contentType: "text/plain",
            payload: {
              text: input.run.message,
            },
          };
        },
      },
      run: {
        message: "hello",
      },
      status: "succeeded",
    };

    expectTypeOf(sampleEnvelope).toMatchTypeOf<RunEnvelope>();
    expectTypeOf(sampleFinalizeInput).toMatchTypeOf<RunEnvelopeFinalizationInput>();
    expectTypeOf<RunEnvelopeMode>().toEqualTypeOf<"sync" | "async">();
    expectTypeOf<RunEnvelopeStatus>().toEqualTypeOf<"created" | "running" | "succeeded" | "failed" | "cancelled">();
    expectTypeOf<RunEnvelopeTerminalStatus>().toEqualTypeOf<"succeeded" | "failed" | "cancelled">();

    expect(sampleEnvelope.kind).toBe("run-envelope");
    expect(sampleEnvelope.status).toBe("created");
    expect(sampleEnvelope.eventStream?.kind).toBe("event-stream-reference");
  });
});
