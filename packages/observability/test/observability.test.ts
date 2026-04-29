import { describe, expect, it } from "vitest";
import { createCanonicalEvent, type AgentHarnessRunResult } from "@generic-ai/sdk";
import { createObservabilityAgentTools } from "../src/agent-tools.js";
import { getObservabilityMetricCatalog, assertMetricAttributesAreBounded } from "../src/metrics.js";
import { MemoryObservabilityRepository, SqliteObservabilityRepository } from "../src/repository.js";
import { redactJsonValue, summarizePayload } from "../src/redaction.js";
import { createGenericAIObservabilityRoutes, ingestObservabilityEvent } from "../src/server.js";
import { createObservabilityLiveEventBus } from "../src/sse.js";
import type { ObservabilityMetricPoint } from "../src/types.js";

const workspaceId = "workspace-a";

describe("observability repositories", () => {
  it.each([
    ["memory", () => new MemoryObservabilityRepository()],
    ["sqlite", () => new SqliteObservabilityRepository({ path: ":memory:" })],
  ])("stores runs, deduplicates events, isolates workspaces, and sweeps safely with %s", async (_name, createRepository) => {
    const repository = createRepository();
    const result = fakeRunResult("run-1");
    await repository.ingestRunResult({ workspaceId, result });
    await repository.ingestRunResult({ workspaceId, result });
    await repository.ingestRunResult({ workspaceId: "workspace-b", result: fakeRunResult("run-2") });

    const run = await repository.getRun(workspaceId, "run-1");
    expect(run?.eventCount).toBe(2);
    expect(run?.status).toBe("succeeded");
    expect(run?.metadata["payloadPosture"]).toBe("metadata_only");

    const workspaceRuns = await repository.listRuns({ workspaceId });
    expect(workspaceRuns.map((item) => item.runId)).toEqual(["run-1"]);

    const trace = await repository.getTrace(workspaceId, "run-1");
    expect(trace?.events).toHaveLength(2);
    expect(JSON.stringify(trace?.events)).not.toContain("sk-secret");

    await repository.setPin(workspaceId, "run-1", true);
    const dryRun = await repository.sweepRetention({ workspaceId, maxBytes: 1, dryRun: true });
    expect(dryRun.deletedRunIds).toEqual([]);
    expect(dryRun.retainedPinnedRunIds).toEqual(["run-1"]);

    await repository.setPin(workspaceId, "run-1", false);
    const sweep = await repository.sweepRetention({ workspaceId, maxBytes: 1 });
    expect(sweep.deletedRunIds).toEqual(["run-1"]);
    expect(await repository.getRun(workspaceId, "run-1")).toBeUndefined();

    if ("close" in repository) {
      repository.close();
    }
  });

  it("keeps active runs during retention sweeps", async () => {
    const repository = new MemoryObservabilityRepository();
    await repository.appendEvent({
      workspaceId,
      event: {
        id: "event-1",
        workspaceId,
        runId: "active-run",
        sequence: 1,
        occurredAt: "2026-04-27T00:00:00.000Z",
        name: "run.started",
        family: "run",
        source: "canonical_event",
        summary: "started",
        payload: summarizePayload({ ok: true }),
      },
    });

    const sweep = await repository.sweepRetention({ workspaceId, maxBytes: 1 });
    expect(sweep.deletedRunIds).toEqual([]);
    expect(sweep.retainedActiveRunIds).toEqual(["active-run"]);
  });
});

describe("redaction and metric guardrails", () => {
  it("defaults to metadata-only and redacts opt-in payloads fail closed", () => {
    const metadataOnly = summarizePayload({
      env: "OPENAI_API_KEY=sk-secret",
      nested: { authorization: "Bearer abcdefghijklmnop" },
    });
    expect(metadataOnly.posture).toBe("metadata_only");
    expect(JSON.stringify(metadataOnly)).not.toContain("sk-secret");

    const redacted = redactJsonValue({
      env: "OPENAI_API_KEY=sk-secret",
      nested: { authorization: "Bearer abcdefghijklmnop" },
      binary: new Uint8Array([1, 2, 3]),
    });
    expect(JSON.stringify(redacted)).not.toContain("Bearer abc");
    expect(JSON.stringify(redacted)).toContain("[binary payload omitted]");
  });

  it("locks metric vocabulary and rejects unbounded attributes", () => {
    expect(getObservabilityMetricCatalog().map((metric) => metric.name)).toContain(
      "generic_ai.run.events.count",
    );

    const point: ObservabilityMetricPoint = {
      id: "bad",
      workspaceId,
      runId: "run-1",
      name: "generic_ai.run.events.count",
      unit: "count",
      value: 1,
      occurredAt: "2026-04-27T00:00:00.000Z",
      attributes: { workspace_id: workspaceId, run_id: "run-1" },
      evidenceEventIds: [],
    };
    expect(() => assertMetricAttributesAreBounded(point)).toThrow(/unapproved attribute/);
  });
});

describe("observability routes and live events", () => {
  it("requires a local token, rejects bad origins, and serves read-only traces", async () => {
    const repository = new MemoryObservabilityRepository();
    await repository.ingestRunResult({ workspaceId, result: fakeRunResult("route-run") });
    const routes = createGenericAIObservabilityRoutes({ repository, workspaceId });

    const unauthenticated = await routes.fetch(
      new Request("http://localhost/runs", { headers: { host: "localhost" } }),
    );
    expect(unauthenticated.status).toBe(401);

    const token = routes.localSessionToken ?? "";
    const trace = await routes.fetch(
      new Request("http://localhost/runs/route-run/trace", {
        headers: { authorization: `Bearer ${token}`, host: "localhost" },
      }),
    );
    expect(trace.status).toBe(200);
    expect(await trace.json()).toHaveProperty("trace");

    const badOrigin = await routes.fetch(
      new Request("http://localhost/reports", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          host: "localhost",
          origin: "http://evil.example",
        },
      }),
    );
    expect(badOrigin.status).toBe(403);

    const disabled = await routes.fetch(
      new Request("http://localhost/exports/otel", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, host: "localhost" },
      }),
    );
    expect(disabled.status).toBe(403);
  });

  it("replays live events and disconnects slow subscribers", () => {
    const disconnected: string[] = [];
    const bus = createObservabilityLiveEventBus({
      maxSubscriberQueue: 0,
      onDisconnect(reason) {
        disconnected.push(reason);
      },
    });
    bus.publish("seed", { workspaceId });
    const replayed: number[] = [];
    const subscription = bus.subscribe((event) => replayed.push(event.sequence), {
      fromSequence: 1,
    });
    expect(replayed).toEqual([1]);

    bus.publish("next", { workspaceId });
    expect(subscription.closed).toBe(true);
    expect(disconnected).toContain("slow_consumer");
  });

  it("mounts an integration fixture, ingests an event, queries metrics, and exposes read-only tools", async () => {
    const repository = new MemoryObservabilityRepository();
    const eventBus = createObservabilityLiveEventBus();
    const routes = createGenericAIObservabilityRoutes({ repository, workspaceId, eventBus });
    const event = createCanonicalEvent({
      eventId: "ingest-1",
      sequence: 1,
      occurredAt: "2026-04-27T00:00:00.000Z",
      name: "run.completed",
      scopeId: "scope-1",
      runId: "ingested-run",
      rootSessionId: "session-1",
      sessionId: "session-1",
      data: { result: "ok" },
    });

    await ingestObservabilityEvent({
      repository,
      workspaceId,
      event: {
        id: event.eventId,
        workspaceId,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        name: event.name,
        family: "run",
        source: "canonical_event",
        summary: event.name,
        payload: summarizePayload(event.data),
      },
      eventBus,
    });

    const token = routes.localSessionToken ?? "";
    const metrics = await routes.fetch(
      new Request("http://localhost/metrics/query?name=generic_ai.run.events.count", {
        headers: { authorization: `Bearer ${token}`, host: "localhost" },
      }),
    );
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toHaveProperty("metrics");

    const tools = createObservabilityAgentTools(repository);
    await expect(tools.getMetricCatalog()).resolves.toHaveProperty("metrics");
  });
});

function fakeRunResult(runId: string): AgentHarnessRunResult {
  return {
    harnessId: "harness-1",
    adapter: "pi",
    status: "succeeded",
    outputText: "model output with sk-secret should not be stored",
    envelope: {
      kind: "run-envelope",
      runId,
      rootScopeId: "scope-1",
      mode: "sync",
      status: "succeeded",
      timestamps: {
        createdAt: "2026-04-27T00:00:00.000Z",
        startedAt: "2026-04-27T00:00:01.000Z",
        completedAt: "2026-04-27T00:00:03.000Z",
      },
    },
    events: [
      createCanonicalEvent({
        eventId: `${runId}-started`,
        sequence: 1,
        occurredAt: "2026-04-27T00:00:01.000Z",
        name: "run.started",
        scopeId: "scope-1",
        runId,
        rootSessionId: "session-1",
        sessionId: "session-1",
        data: { prompt: "OPENAI_API_KEY=sk-secret" },
      }),
      createCanonicalEvent({
        eventId: `${runId}-completed`,
        sequence: 2,
        occurredAt: "2026-04-27T00:00:03.000Z",
        name: "run.completed",
        scopeId: "scope-1",
        runId,
        rootSessionId: "session-1",
        sessionId: "session-1",
        data: { status: "ok" },
      }),
    ],
    projections: [],
    artifacts: [],
    policyDecisions: [],
    hookDecisions: [],
  };
}
