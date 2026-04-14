import { describe, expect, it } from "vitest";
import type {
  AgentSessionRuntime,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  CreateAgentSessionRuntimeResult,
} from "@mariozechner/pi-coding-agent";
import { createPiAgentSession, createPiAgentSessionRuntime } from "../../src/runtime/index.js";

describe("@generic-ai/core pi runtime adapter", () => {
  it("passes createAgentSession options through without normalization", async () => {
    const options = {
      cwd: "/workspace",
      agentDir: "/workspace/.pi/agent",
    } satisfies CreateAgentSessionOptions;

    const result = await createPiAgentSession(options, {
      createAgentSession: async (received) => {
        expect(received).toBe(options);
        return {
          session: { sessionId: "session-001" },
          extensionsResult: {
            extensionCount: 0,
            loadErrors: [],
            loadedExtensions: [],
            commands: [],
            tools: [],
          },
        } as CreateAgentSessionResult;
      },
    });

    expect(result.session).toEqual({ sessionId: "session-001" });
  });

  it("passes createAgentSessionRuntime through to the injected factory", async () => {
    const options = {
      cwd: "/workspace",
      agentDir: "/workspace/.pi/agent",
      sessionManager: {} as never,
    } satisfies Parameters<typeof createPiAgentSessionRuntime>[1];

    const runtime = await createPiAgentSessionRuntime(
      async () =>
        ({
          session: { sessionId: "session-002" },
          extensionsResult: {
            extensionCount: 0,
            loadErrors: [],
            loadedExtensions: [],
            commands: [],
            tools: [],
          },
          services: {} as never,
          diagnostics: [],
        }) as CreateAgentSessionRuntimeResult,
      options,
      {
        createAgentSessionRuntime: async (receivedFactory, receivedOptions) => {
          expect(receivedOptions).toBe(options);
          expect(receivedFactory).toBeTypeOf("function");
          return {
            session: { sessionId: "session-003" },
          } as AgentSessionRuntime;
        },
      },
    );

    expect(runtime.session).toEqual({ sessionId: "session-003" });
  });
});
