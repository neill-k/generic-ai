import assert from "node:assert/strict";
import type { RunStoreContract } from "../contracts/run-store.js";
import { isRunStoreError } from "../contracts/run-store.js";
import type { CanonicalEvent } from "../events/taxonomy.js";
import type { RunEnvelope, RunEnvelopeStatus } from "../run-envelope/index.js";
import { createManualClock, type ManualClock } from "./clock.js";
import type { ConformanceCase } from "./durable-queue-conformance.js";

export interface RunStoreConformanceHarness {
  readonly store: RunStoreContract;
  /** Opens a second handle on the same backing store. Omit for non-persistent backends. */
  reopen?(): Promise<RunStoreContract>;
  dispose(): Promise<void>;
}

/** Creates a fresh, empty run store that reads time from `clock`. */
export type RunStoreConformanceFactory = (
  clock: ManualClock,
) => Promise<RunStoreConformanceHarness>;

async function withStore(
  factory: RunStoreConformanceFactory,
  body: (harness: RunStoreConformanceHarness, clock: ManualClock) => Promise<void>,
): Promise<void> {
  const clock = createManualClock();
  const harness = await factory(clock);
  try {
    await body(harness, clock);
  } finally {
    await harness.dispose();
  }
}

export function sampleRunEnvelope(
  runId: string,
  overrides: Partial<Pick<RunEnvelope, "status" | "rootScopeId" | "rootAgentId">> = {},
): RunEnvelope {
  return {
    kind: "run-envelope",
    runId,
    rootScopeId: overrides.rootScopeId ?? "scope-root",
    ...(overrides.rootAgentId === undefined ? {} : { rootAgentId: overrides.rootAgentId }),
    mode: "async",
    status: overrides.status ?? "created",
    timestamps: { createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

export function sampleCanonicalEvent(
  runId: string,
  sequence: number,
  overrides: Partial<CanonicalEvent> = {},
): CanonicalEvent {
  return {
    eventId: `${runId}-event-${sequence}`,
    sequence,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    name: "session.started",
    origin: { namespace: "core", subsystem: "test" },
    scopeId: "scope-root",
    runId,
    rootSessionId: "session-root",
    sessionId: "session-root",
    data: { sequence, nested: { ok: true }, list: [1, "two"] },
    ...overrides,
  };
}

async function expectRunStoreError(
  code: Parameters<typeof isRunStoreError>[1],
  operation: () => unknown,
): Promise<void> {
  await assert.rejects(
    async () => {
      await operation();
    },
    (error: unknown) => isRunStoreError(error, code),
  );
}

/**
 * Behavioural cases every `RunStoreContract` backend must pass.
 */
export function runStoreConformanceCases(
  factory: RunStoreConformanceFactory,
): readonly ConformanceCase[] {
  return [
    {
      name: "saveRun creates and updates runs with versions and timestamps",
      run: () =>
        withStore(factory, async ({ store }, clock) => {
          const created = await store.saveRun({
            envelope: sampleRunEnvelope("run-1"),
            metadata: { owner: "neill", tags: ["a"] },
          });
          assert.equal(created.runId, "run-1");
          assert.equal(created.version, 1);
          assert.equal(created.createdAt, new Date(clock.now()).toISOString());
          assert.equal(created.updatedAt, created.createdAt);
          assert.deepEqual(created.metadata, { owner: "neill", tags: ["a"] });

          clock.advance(1_000);
          const running = await store.saveRun({
            envelope: { ...sampleRunEnvelope("run-1"), status: "running" },
          });
          assert.equal(running.version, 2);
          assert.equal(running.createdAt, created.createdAt);
          assert.equal(running.updatedAt, new Date(clock.now()).toISOString());
          assert.equal(running.envelope.status, "running");

          const fetched = await store.getRun("run-1");
          assert.equal(fetched?.version, 2);
          assert.equal(fetched?.envelope.status, "running");
          assert.deepEqual(fetched?.envelope.timestamps, { createdAt: "2026-01-01T00:00:00.000Z" });
          assert.equal(await store.getRun("missing"), undefined);
        }),
    },
    {
      name: "saveRun enforces expectedVersion",
      run: () =>
        withStore(factory, async ({ store }) => {
          await store.saveRun({ envelope: sampleRunEnvelope("run-1"), expectedVersion: 0 });
          await expectRunStoreError("VERSION_CONFLICT", () =>
            store.saveRun({ envelope: sampleRunEnvelope("run-1"), expectedVersion: 0 }),
          );
          await expectRunStoreError("VERSION_CONFLICT", () =>
            store.saveRun({ envelope: sampleRunEnvelope("run-1"), expectedVersion: 7 }),
          );
          const updated = await store.saveRun({
            envelope: sampleRunEnvelope("run-1", { status: "running" }),
            expectedVersion: 1,
          });
          assert.equal(updated.version, 2);
          await expectRunStoreError("VERSION_CONFLICT", () =>
            store.saveRun({ envelope: sampleRunEnvelope("run-2"), expectedVersion: 1 }),
          );
        }),
    },
    {
      name: "concurrent saves with the same expectedVersion let exactly one win",
      run: () =>
        withStore(factory, async ({ store }) => {
          await store.saveRun({ envelope: sampleRunEnvelope("run-1") });
          const statuses: RunEnvelopeStatus[] = ["running", "cancelled", "failed", "succeeded"];
          const outcomes = await Promise.allSettled(
            statuses.map((status) =>
              Promise.resolve(
                store.saveRun({
                  envelope: sampleRunEnvelope("run-1", { status }),
                  expectedVersion: 1,
                }),
              ),
            ),
          );
          const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
          assert.equal(fulfilled.length, 1);
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") {
              assert.ok(isRunStoreError(outcome.reason, "VERSION_CONFLICT"));
            }
          }
          assert.equal((await store.getRun("run-1"))?.version, 2);
        }),
    },
    {
      name: "listRuns filters by status and scope, newest first, with paging",
      run: () =>
        withStore(factory, async ({ store }, clock) => {
          await store.saveRun({ envelope: sampleRunEnvelope("a", { status: "running" }) });
          clock.advance(1);
          await store.saveRun({ envelope: sampleRunEnvelope("b", { status: "succeeded" }) });
          clock.advance(1);
          await store.saveRun({
            envelope: sampleRunEnvelope("c", { status: "running", rootScopeId: "other" }),
          });

          assert.deepEqual(
            (await store.listRuns()).map((run) => run.runId),
            ["c", "b", "a"],
          );
          assert.deepEqual(
            (await store.listRuns({ status: "running" })).map((run) => run.runId),
            ["c", "a"],
          );
          assert.deepEqual(
            (await store.listRuns({ status: ["succeeded", "failed"] })).map((run) => run.runId),
            ["b"],
          );
          assert.deepEqual(
            (await store.listRuns({ rootScopeId: "scope-root" })).map((run) => run.runId),
            ["b", "a"],
          );
          const firstPage = await store.listRuns({ limit: 2 });
          assert.deepEqual(
            firstPage.map((run) => run.runId),
            ["c", "b"],
          );
          const cursor = firstPage.at(-1)?.createdAt;
          assert.ok(cursor);
          assert.deepEqual(
            (await store.listRuns({ createdBefore: cursor })).map((run) => run.runId),
            ["a"],
          );
        }),
    },
    {
      name: "sessions are saved, versioned and listed per run",
      run: () =>
        withStore(factory, async ({ store }, clock) => {
          await store.saveRun({ envelope: sampleRunEnvelope("run-1") });
          const root = await store.saveSession({
            sessionId: "root",
            runId: "run-1",
            agentId: "ceo",
            status: "active",
            state: { messages: [{ role: "user", content: "hi" }] },
          });
          assert.equal(root.version, 1);
          clock.advance(1);
          await store.saveSession({
            sessionId: "child",
            runId: "run-1",
            parentSessionId: "root",
            agentId: "vp-eng",
            status: "active",
            metadata: { depth: 1 },
          });
          clock.advance(1);
          const done = await store.saveSession({
            sessionId: "root",
            runId: "run-1",
            agentId: "ceo",
            status: "succeeded",
            state: { messages: [] },
            expectedVersion: 1,
          });
          assert.equal(done.version, 2);
          assert.equal(done.createdAt, root.createdAt);
          await expectRunStoreError("VERSION_CONFLICT", () =>
            store.saveSession({
              sessionId: "root",
              runId: "run-1",
              status: "failed",
              expectedVersion: 1,
            }),
          );

          const fetched = await store.getSession("child");
          assert.equal(fetched?.parentSessionId, "root");
          assert.equal(fetched?.agentId, "vp-eng");
          assert.deepEqual(fetched?.metadata, { depth: 1 });
          assert.equal(await store.getSession("missing"), undefined);
          assert.deepEqual(
            (await store.listSessions("run-1")).map((session) => session.sessionId),
            ["root", "child"],
          );
          assert.deepEqual(await store.listSessions("other-run"), []);
          assert.deepEqual((await store.getSession("root"))?.state, { messages: [] });
        }),
    },
    {
      name: "appendEvents stores events in sequence order and readEvents pages",
      run: () =>
        withStore(factory, async ({ store }) => {
          assert.equal(await store.lastSequence("run-1"), 0);
          const result = await store.appendEvents("run-1", [
            sampleCanonicalEvent("run-1", 1),
            sampleCanonicalEvent("run-1", 2),
          ]);
          assert.deepEqual(result, { appended: 2, lastSequence: 2 });
          await store.appendEvents("run-1", [
            sampleCanonicalEvent("run-1", 3, {
              name: "plugin.web-ui.message",
              origin: { namespace: "plugin", pluginId: "@x/y" },
            }),
          ]);
          await store.appendEvents("run-2", [sampleCanonicalEvent("run-2", 1)]);

          const all = await store.readEvents("run-1");
          assert.deepEqual(
            all.map((event) => event.sequence),
            [1, 2, 3],
          );
          assert.deepEqual(all[0], sampleCanonicalEvent("run-1", 1));
          assert.equal(all[2]?.origin.pluginId, "@x/y");
          assert.deepEqual(
            (await store.readEvents("run-1", { fromSequence: 2 })).map((event) => event.sequence),
            [2, 3],
          );
          assert.deepEqual(
            (await store.readEvents("run-1", { fromSequence: 1, limit: 2 })).map(
              (event) => event.sequence,
            ),
            [1, 2],
          );
          assert.equal(await store.lastSequence("run-1"), 3);
          assert.equal(await store.lastSequence("run-2"), 1);
        }),
    },
    {
      name: "appendEvents is idempotent and rejects conflicting sequences",
      run: () =>
        withStore(factory, async ({ store }) => {
          await store.appendEvents("run-1", [sampleCanonicalEvent("run-1", 1)]);
          const again = await store.appendEvents("run-1", [
            sampleCanonicalEvent("run-1", 1),
            sampleCanonicalEvent("run-1", 2),
          ]);
          assert.deepEqual(again, { appended: 1, lastSequence: 2 });
          await expectRunStoreError("SEQUENCE_CONFLICT", () =>
            store.appendEvents("run-1", [
              sampleCanonicalEvent("run-1", 2, { eventId: "different" }),
            ]),
          );
          await expectRunStoreError("INVALID_INPUT", () =>
            store.appendEvents("run-1", [sampleCanonicalEvent("run-9", 3)]),
          );
          await expectRunStoreError("INVALID_INPUT", () =>
            store.appendEvents("run-1", [sampleCanonicalEvent("run-1", 0)]),
          );
          assert.equal((await store.readEvents("run-1")).length, 2);
          assert.deepEqual(await store.appendEvents("run-1", []), {
            appended: 0,
            lastSequence: 2,
          });
        }),
    },
    {
      name: "deleteRun removes the run, its sessions and its events",
      run: () =>
        withStore(factory, async ({ store }) => {
          await store.saveRun({ envelope: sampleRunEnvelope("run-1") });
          await store.saveSession({ sessionId: "s", runId: "run-1", status: "active" });
          await store.appendEvents("run-1", [sampleCanonicalEvent("run-1", 1)]);
          await store.saveRun({ envelope: sampleRunEnvelope("run-2") });

          assert.equal(await store.deleteRun("run-1"), true);
          assert.equal(await store.getRun("run-1"), undefined);
          assert.equal(await store.getSession("s"), undefined);
          assert.deepEqual(await store.readEvents("run-1"), []);
          assert.ok(await store.getRun("run-2"));
          assert.equal(await store.deleteRun("run-1"), false);
        }),
    },
    {
      name: "runs, sessions and events survive reopening the store",
      run: () =>
        withStore(factory, async (harness) => {
          if (!harness.reopen) {
            return;
          }
          await harness.store.saveRun({
            envelope: sampleRunEnvelope("run-1", { status: "running" }),
          });
          await harness.store.saveSession({ sessionId: "s", runId: "run-1", status: "active" });
          await harness.store.appendEvents("run-1", [
            sampleCanonicalEvent("run-1", 1),
            sampleCanonicalEvent("run-1", 2),
          ]);
          const reopened = await harness.reopen();
          try {
            assert.equal((await reopened.getRun("run-1"))?.envelope.status, "running");
            assert.equal((await reopened.getSession("s"))?.status, "active");
            assert.equal(await reopened.lastSequence("run-1"), 2);
          } finally {
            await reopened.close?.();
          }
        }),
    },
  ];
}
