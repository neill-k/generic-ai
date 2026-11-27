import {
  type AgentTaskExecutionInput,
  type CompiledHarness,
  compileHarnessDsl,
  HARNESS_SCHEMA_VERSION,
  type SaveSessionInput,
  type SessionRecord,
} from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { TopologyActorInvocation, TopologyActorResult } from "./topology-runner.js";
import {
  createTopologyTaskExecutor,
  topologyCheckpointSessionId,
} from "./topology-task-executor.js";

function pipeline(): CompiledHarness {
  const agents = [
    { id: "researcher", role: "researcher" },
    { id: "writer", role: "writer" },
    { id: "editor", role: "editor" },
  ];
  const result = compileHarnessDsl({
    kind: "generic-ai.harness",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: "h.pipeline",
    packages: [{ id: "protocol", package: "@generic-ai/protocol-pipeline" }],
    agents: agents.map((agent) => ({ ...agent, packageRefs: ["protocol"] })),
    spaces: [{ id: "board", kind: "workspace", visibility: "shared" }],
    protocols: [
      {
        id: "pipeline-binding",
        protocol: "pipeline",
        packageRef: "protocol",
        actorRefs: agents.map((agent) => agent.id),
      },
    ],
  });
  if (result.compiled === undefined) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.compiled;
}

function memoryCheckpoints() {
  const sessions = new Map<string, SessionRecord>();
  return {
    sessions,
    getSession: async (id: string) => sessions.get(id),
    saveSession: async (input: SaveSessionInput) => {
      const previous = sessions.get(input.sessionId);
      if (
        input.expectedVersion !== undefined &&
        (previous?.version ?? 0) !== input.expectedVersion
      ) {
        throw new Error("version conflict");
      }
      const record: SessionRecord = {
        ...input,
        version: (previous?.version ?? 0) + 1,
        createdAt: previous?.createdAt ?? "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      sessions.set(input.sessionId, record);
      return record;
    },
  };
}

const turn = (attempt: number): AgentTaskExecutionInput => ({
  taskId: "task-1",
  attemptRunId: `task-1:turn-0:attempt-${attempt}`,
  rootTaskId: "task-1",
  agentId: "content-lead",
  role: "lead",
  prompt: "Write the launch post",
  workspaceRoot: "/agents/content-lead",
  metadata: { round: 0 },
});

describe("createTopologyTaskExecutor", () => {
  it("runs a topology as one task turn and retries only the actions that did not succeed", async () => {
    const checkpoints = memoryCheckpoints();
    const calls: string[] = [];
    let crash = true;
    const runner = async (invocation: TopologyActorInvocation): Promise<TopologyActorResult> => {
      calls.push(invocation.actor.id);
      if (invocation.actor.id === "editor" && crash) {
        crash = false;
        throw new Error("process died");
      }
      return { status: "succeeded", outputText: `${invocation.actor.id} output` };
    };
    const executor = createTopologyTaskExecutor({
      compiled: pipeline(),
      runner,
      checkpoints,
      maxAttempts: 1,
    });

    const first = await executor(turn(1));
    expect(first.status).toBe("failed");
    expect(calls).toEqual(["researcher", "writer", "editor"]);
    const saved = checkpoints.sessions.get(topologyCheckpointSessionId(turn(1)));
    expect(saved?.status).toBe("failed");

    calls.length = 0;
    const second = await executor(turn(2));
    expect(second).toMatchObject({ status: "succeeded", outputText: "editor output" });
    expect(calls).toEqual(["editor"]);
    expect(second.runIds).toEqual(["task-1:turn-0:attempt-2"]);
  });

  it("needs a runner", () => {
    expect(() => createTopologyTaskExecutor({ compiled: pipeline() })).toThrow(/runner/);
  });
});
