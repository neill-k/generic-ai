import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getCanonicalEventFamily,
  type AgentHarnessRunResult,
  type CanonicalEvent,
} from "@generic-ai/sdk";
import { deriveEventCountMetric, deriveRunMetrics, metricPoint } from "./metrics.js";
import { byteSize, summarizePayload } from "./redaction.js";
import type {
  ObservabilityAppendEventInput,
  ObservabilityAppendEventResult,
  ObservabilityEventListFilter,
  ObservabilityEventRecord,
  ObservabilityIngestRunResultInput,
  ObservabilityMetricPoint,
  ObservabilityMetricQuery,
  ObservabilityRepository,
  ObservabilityRetentionPolicy,
  ObservabilityRunListFilter,
  ObservabilityRunRecord,
  ObservabilityRunStatus,
  ObservabilitySweepResult,
  ObservabilityTraceRecord,
} from "./types.js";

type TraceExtras = Pick<
  ObservabilityTraceRecord,
  "projections" | "artifacts" | "policyDecisions" | "traceEvents"
>;

interface RunState {
  run: ObservabilityRunRecord;
  events: Map<string, ObservabilityEventRecord>;
  metrics: Map<string, ObservabilityMetricPoint>;
  extras: TraceExtras;
}

type SqliteRunRow = {
  workspace_id: string;
  run_id: string;
  updated_at: string;
  status: ObservabilityRunStatus;
  pinned: number;
  active: number;
  byte_size: number;
  value: string;
};

type SqliteValueRow = {
  value: string;
};

type SqliteEventRow = {
  value: string;
  sequence: number;
  occurred_at: string;
};

export interface MemoryObservabilityRepositoryOptions {
  readonly now?: () => string;
}

export interface SqliteObservabilityRepositoryOptions {
  readonly path: string;
  readonly migrate?: boolean;
  readonly busyTimeoutMs?: number;
  readonly now?: () => string;
}

const TERMINAL_STATUSES = new Set<ObservabilityRunStatus>(["succeeded", "failed", "cancelled"]);

export abstract class BaseObservabilityRepository implements ObservabilityRepository {
  protected readonly now: () => string;

  protected constructor(options: { readonly now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  abstract appendEvent(input: ObservabilityAppendEventInput): Promise<ObservabilityAppendEventResult>;
  abstract listRuns(filter: ObservabilityRunListFilter): Promise<readonly ObservabilityRunRecord[]>;
  abstract getRun(workspaceId: string, runId: string): Promise<ObservabilityRunRecord | undefined>;
  abstract listEvents(
    filter: ObservabilityEventListFilter,
  ): Promise<readonly ObservabilityEventRecord[]>;
  abstract getTrace(
    workspaceId: string,
    runId: string,
  ): Promise<ObservabilityTraceRecord | undefined>;
  abstract setPin(
    workspaceId: string,
    runId: string,
    pinned: boolean,
  ): Promise<ObservabilityRunRecord>;
  abstract markExported(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<ObservabilityRunRecord>;
  abstract queryMetrics(query: ObservabilityMetricQuery): Promise<readonly ObservabilityMetricPoint[]>;
  abstract sweepRetention(policy: ObservabilityRetentionPolicy): Promise<ObservabilitySweepResult>;

  protected abstract replaceRun(run: ObservabilityRunRecord): Promise<ObservabilityRunRecord>;
  protected abstract recordTraceExtras(
    workspaceId: string,
    runId: string,
    extras: TraceExtras,
  ): Promise<ObservabilityRunRecord>;
  protected abstract upsertMetric(point: ObservabilityMetricPoint): Promise<void>;

  async ingestRunResult<TOutput = string>(
    input: ObservabilityIngestRunResultInput<TOutput>,
  ): Promise<ObservabilityRunRecord> {
    const runId = input.result.envelope.runId;
    const workspaceId = normalizeId(input.workspaceId, "workspaceId");

    for (const event of input.result.events) {
      await this.appendEvent({
        workspaceId,
        event: canonicalEventToObservabilityEvent(workspaceId, event),
      });
    }

    for (const projection of input.result.projections) {
      await this.appendEvent({
        workspaceId,
        event: Object.freeze({
          id: `projection:${projection.id}`,
          workspaceId,
          runId,
          sequence: projection.sequence,
          occurredAt: projection.occurredAt,
          name: projection.type,
          family: "projection",
          source: "harness_projection",
          summary: projection.summary,
          payload: summarizePayload(projection.data),
        }),
      });
    }

    await this.recordTraceExtras(workspaceId, runId, {
      projections: input.result.projections,
      artifacts: input.result.artifacts,
      policyDecisions: input.result.policyDecisions,
      traceEvents: [],
    });

    const existing = await this.getRun(workspaceId, runId);
    const run = existing ?? createInitialRun(workspaceId, runId, this.now());
    const status = mapRunStatus(input.result.envelope.status);
    const next = mergeRun(run, {
      status,
      harnessId: input.result.harnessId,
      rootScopeId: input.result.envelope.rootScopeId,
      active: !TERMINAL_STATUSES.has(status),
      updatedAt: input.result.envelope.timestamps.completedAt ?? this.now(),
      artifactCount: input.result.artifacts.length,
      policyDecisionCount: input.result.policyDecisions.length,
      metadata: {
        payloadPosture: "metadata_only",
        adapter: input.result.adapter,
        failure: input.result.failureMessage ?? "",
        errorCategory: input.result.errorCategory ?? "",
        output: summarizePayload(input.result.outputText).metadata,
      },
      byteSize: run.byteSize + byteSize(input.result.artifacts) + byteSize(input.result.policyDecisions),
      ...(input.result.envelope.timestamps.startedAt === undefined
        ? {}
        : { startedAt: input.result.envelope.timestamps.startedAt }),
      ...(input.result.envelope.timestamps.completedAt === undefined
        ? {}
        : { completedAt: input.result.envelope.timestamps.completedAt }),
      ...(input.result.envelope.rootAgentId === undefined
        ? {}
        : { rootAgentId: input.result.envelope.rootAgentId }),
    });
    const replaced = await this.replaceRun(next);

    for (const decision of input.result.policyDecisions) {
      await this.upsertMetric(
        metricPoint({
          workspaceId,
          runId,
          name: "generic_ai.policy.decisions.count",
          value: 1,
          occurredAt: replaced.updatedAt,
          attributes: {
            workspace_id: workspaceId,
            effect: decision.effect,
            decision: decision.decision,
          },
          evidenceEventIds: decision.evidenceRefs,
        }),
      );
    }

    for (const metric of deriveRunMetrics(replaced)) {
      await this.upsertMetric(metric);
    }

    const finalRun = await this.getRun(workspaceId, runId);
    if (!finalRun) {
      throw new Error(`Run "${runId}" was not stored.`);
    }

    return finalRun;
  }
}

export class MemoryObservabilityRepository extends BaseObservabilityRepository {
  #states = new Map<string, RunState>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: MemoryObservabilityRepositoryOptions = {}) {
    super(options);
  }

  async appendEvent(input: ObservabilityAppendEventInput): Promise<ObservabilityAppendEventResult> {
    return this.#exclusive(() => {
      const state = this.#ensureState(input.workspaceId, input.event.runId);
      const existing = state.events.get(input.event.id);
      if (existing) {
        return { event: existing, run: state.run, inserted: false };
      }

      state.events.set(input.event.id, input.event);
      state.metrics.set(deriveEventCountMetric(input.event).id, deriveEventCountMetric(input.event));
      state.run = updateRunForEvent(state.run, input.event, state.events.size, state.metrics.size);
      for (const metric of deriveRunMetrics(state.run)) {
        state.metrics.set(metric.id, metric);
      }
      state.run = mergeRun(state.run, { metricCount: state.metrics.size });

      return { event: input.event, run: state.run, inserted: true };
    });
  }

  async listRuns(filter: ObservabilityRunListFilter): Promise<readonly ObservabilityRunRecord[]> {
    return this.#exclusive(() => {
      const runs = [...this.#states.values()]
        .map((state) => state.run)
        .filter((run) => run.workspaceId === filter.workspaceId)
        .filter((run) => (filter.status ? run.status === filter.status : true))
        .filter((run) => (filter.from ? run.updatedAt >= filter.from : true))
        .filter((run) => (filter.to ? run.updatedAt <= filter.to : true))
        .sort((left, right) =>
          filter.order === "asc"
            ? left.updatedAt.localeCompare(right.updatedAt)
            : right.updatedAt.localeCompare(left.updatedAt),
        );
      return Object.freeze(runs.slice(0, filter.limit ?? runs.length));
    });
  }

  async getRun(workspaceId: string, runId: string): Promise<ObservabilityRunRecord | undefined> {
    return this.#exclusive(() => this.#states.get(stateKey(workspaceId, runId))?.run);
  }

  async listEvents(
    filter: ObservabilityEventListFilter,
  ): Promise<readonly ObservabilityEventRecord[]> {
    return this.#exclusive(() => {
      const state = this.#states.get(stateKey(filter.workspaceId, filter.runId));
      if (!state) {
        return Object.freeze([]);
      }

      const events = [...state.events.values()]
        .filter((event) =>
          filter.fromSequence === undefined ? true : event.sequence >= filter.fromSequence,
        )
        .sort(compareEvents);
      return Object.freeze(events.slice(0, filter.limit ?? events.length));
    });
  }

  async getTrace(
    workspaceId: string,
    runId: string,
  ): Promise<ObservabilityTraceRecord | undefined> {
    return this.#exclusive(() => {
      const state = this.#states.get(stateKey(workspaceId, runId));
      if (!state) {
        return undefined;
      }

      return Object.freeze({
        run: state.run,
        events: Object.freeze([...state.events.values()].sort(compareEvents)),
        projections: Object.freeze([...state.extras.projections]),
        artifacts: Object.freeze([...state.extras.artifacts]),
        policyDecisions: Object.freeze([...state.extras.policyDecisions]),
        traceEvents: Object.freeze([...state.extras.traceEvents]),
      });
    });
  }

  async setPin(
    workspaceId: string,
    runId: string,
    pinned: boolean,
  ): Promise<ObservabilityRunRecord> {
    return this.#exclusive(() => {
      const state = this.#requireState(workspaceId, runId);
      state.run = mergeRun(state.run, { pinned, updatedAt: this.now() });
      return state.run;
    });
  }

  async markExported(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<ObservabilityRunRecord> {
    return this.#exclusive(() => {
      const state = this.#requireState(workspaceId, runId);
      state.run = mergeRun(state.run, {
        exportIds: [...new Set([...state.run.exportIds, normalizeId(exportId, "exportId")])],
        updatedAt: this.now(),
      });
      return state.run;
    });
  }

  async queryMetrics(query: ObservabilityMetricQuery): Promise<readonly ObservabilityMetricPoint[]> {
    return this.#exclusive(() => {
      const metrics = [...this.#states.values()]
        .filter((state) => state.run.workspaceId === query.workspaceId)
        .flatMap((state) => [...state.metrics.values()])
        .filter((point) => (query.names ? query.names.includes(point.name) : true))
        .filter((point) => (query.from ? point.occurredAt >= query.from : true))
        .filter((point) => (query.to ? point.occurredAt <= query.to : true))
        .filter((point) => attributesMatch(point, query.attributes))
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
      return Object.freeze(metrics.slice(0, query.limit ?? metrics.length));
    });
  }

  async sweepRetention(policy: ObservabilityRetentionPolicy): Promise<ObservabilitySweepResult> {
    return this.#exclusive(() => {
      const candidates = [...this.#states.values()]
        .filter((state) => state.run.workspaceId === policy.workspaceId)
        .sort((left, right) => left.run.updatedAt.localeCompare(right.run.updatedAt));
      const retainedPinnedRunIds: string[] = [];
      const retainedActiveRunIds: string[] = [];
      const deletedRunIds: string[] = [];
      let reclaimedBytes = 0;
      let totalBytes = candidates.reduce((total, state) => total + state.run.byteSize, 0);

      for (const state of candidates) {
        const overBytes = policy.maxBytes !== undefined && totalBytes > policy.maxBytes;
        const oldEnough = policy.olderThan !== undefined && state.run.updatedAt < policy.olderThan;
        if (!overBytes && !oldEnough) {
          continue;
        }

        if (state.run.pinned) {
          retainedPinnedRunIds.push(state.run.runId);
          continue;
        }

        if (state.run.active) {
          retainedActiveRunIds.push(state.run.runId);
          continue;
        }

        deletedRunIds.push(state.run.runId);
        reclaimedBytes += state.run.byteSize;
        totalBytes -= state.run.byteSize;
        if (policy.dryRun !== true) {
          this.#states.delete(stateKey(state.run.workspaceId, state.run.runId));
        }
      }

      return Object.freeze({
        workspaceId: policy.workspaceId,
        deletedRunIds: Object.freeze(deletedRunIds),
        retainedPinnedRunIds: Object.freeze(retainedPinnedRunIds),
        retainedActiveRunIds: Object.freeze(retainedActiveRunIds),
        reclaimedBytes,
        dryRun: policy.dryRun === true,
      });
    });
  }

  protected async replaceRun(run: ObservabilityRunRecord): Promise<ObservabilityRunRecord> {
    return this.#exclusive(() => {
      const state = this.#ensureState(run.workspaceId, run.runId);
      state.run = mergeRun(run, { metricCount: state.metrics.size });
      return state.run;
    });
  }

  protected async recordTraceExtras(
    workspaceId: string,
    runId: string,
    extras: TraceExtras,
  ): Promise<ObservabilityRunRecord> {
    return this.#exclusive(() => {
      const state = this.#ensureState(workspaceId, runId);
      state.extras = mergeExtras(state.extras, extras);
      state.run = mergeRun(state.run, {
        artifactCount: state.extras.artifacts.length,
        policyDecisionCount: state.extras.policyDecisions.length,
        byteSize: state.run.byteSize + byteSize(extras),
        updatedAt: this.now(),
      });
      return state.run;
    });
  }

  protected async upsertMetric(point: ObservabilityMetricPoint): Promise<void> {
    return this.#exclusive(() => {
      const state = this.#ensureState(point.workspaceId, point.runId);
      state.metrics.set(point.id, point);
      state.run = mergeRun(state.run, { metricCount: state.metrics.size });
    });
  }

  #ensureState(workspaceId: string, runId: string): RunState {
    const key = stateKey(workspaceId, runId);
    const existing = this.#states.get(key);
    if (existing) {
      return existing;
    }

    const state: RunState = {
      run: createInitialRun(workspaceId, runId, this.now()),
      events: new Map(),
      metrics: new Map(),
      extras: emptyExtras(),
    };
    this.#states.set(key, state);
    return state;
  }

  #requireState(workspaceId: string, runId: string): RunState {
    const state = this.#states.get(stateKey(workspaceId, runId));
    if (!state) {
      throw new Error(`Run "${runId}" was not found in workspace "${workspaceId}".`);
    }

    return state;
  }

  async #exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.#queue;
    let release = () => {};
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

export class SqliteObservabilityRepository
  extends BaseObservabilityRepository
  implements ObservabilityRepository
{
  readonly path: string;
  #db: DatabaseSync;

  constructor(options: SqliteObservabilityRepositoryOptions) {
    super(options);
    this.path = normalizeSqlitePath(options.path);
    if (this.path !== ":memory:") {
      mkdirSync(path.dirname(this.path), { recursive: true });
    }
    this.#db = new DatabaseSync(this.path, { timeout: options.busyTimeoutMs ?? 5_000 });
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA trusted_schema = OFF");
    if (this.path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
    }
    if (options.migrate ?? true) {
      migrateSqliteObservability(this.#db);
    }
  }

  async appendEvent(input: ObservabilityAppendEventInput): Promise<ObservabilityAppendEventResult> {
    return this.#transaction(() => {
      const run = this.#readRun(input.workspaceId, input.event.runId) ??
        createInitialRun(input.workspaceId, input.event.runId, this.now());
      const existing = this.#readEvent(input.workspaceId, input.event.runId, input.event.id);
      if (existing) {
        return { event: existing, run, inserted: false };
      }

      this.#writeRun(run);
      this.#writeEvent(input.event);
      this.#upsertMetricSync(deriveEventCountMetric(input.event));
      const eventCount = this.#eventCount(input.workspaceId, input.event.runId);
      const metricCount = this.#metricCount(input.workspaceId, input.event.runId);
      let next = updateRunForEvent(run, input.event, eventCount, metricCount);
      this.#writeRun(next);
      for (const metric of deriveRunMetrics(next)) {
        this.#upsertMetricSync(metric);
      }
      next = mergeRun(next, { metricCount: this.#metricCount(input.workspaceId, input.event.runId) });
      this.#writeRun(next);
      return { event: input.event, run: next, inserted: true };
    });
  }

  async listRuns(filter: ObservabilityRunListFilter): Promise<readonly ObservabilityRunRecord[]> {
    const rows = this.#db
      .prepare(
        "SELECT value FROM observability_runs WHERE workspace_id = ? ORDER BY updated_at " +
          (filter.order === "asc" ? "ASC" : "DESC"),
      )
      .all(filter.workspaceId) as SqliteValueRow[];
    const runs = rows
      .map((row) => parseJson<ObservabilityRunRecord>(row.value))
      .filter((run) => (filter.status ? run.status === filter.status : true))
      .filter((run) => (filter.from ? run.updatedAt >= filter.from : true))
      .filter((run) => (filter.to ? run.updatedAt <= filter.to : true));
    return Object.freeze(runs.slice(0, filter.limit ?? runs.length));
  }

  async getRun(workspaceId: string, runId: string): Promise<ObservabilityRunRecord | undefined> {
    return this.#readRun(workspaceId, runId);
  }

  async listEvents(
    filter: ObservabilityEventListFilter,
  ): Promise<readonly ObservabilityEventRecord[]> {
    const rows = this.#db
      .prepare(
        "SELECT value, sequence, occurred_at FROM observability_events WHERE workspace_id = ? AND run_id = ? AND sequence >= ? ORDER BY sequence, occurred_at LIMIT ?",
      )
      .all(filter.workspaceId, filter.runId, filter.fromSequence ?? 0, filter.limit ?? 10_000) as
      SqliteEventRow[];
    return Object.freeze(rows.map((row) => parseJson<ObservabilityEventRecord>(row.value)));
  }

  async getTrace(
    workspaceId: string,
    runId: string,
  ): Promise<ObservabilityTraceRecord | undefined> {
    const run = this.#readRun(workspaceId, runId);
    if (!run) {
      return undefined;
    }

    const events = await this.listEvents({ workspaceId, runId });
    const extras = this.#readExtras(workspaceId, runId);
    return Object.freeze({
      run,
      events,
      projections: extras.projections,
      artifacts: extras.artifacts,
      policyDecisions: extras.policyDecisions,
      traceEvents: extras.traceEvents,
    });
  }

  async setPin(
    workspaceId: string,
    runId: string,
    pinned: boolean,
  ): Promise<ObservabilityRunRecord> {
    return this.#transaction(() => {
      const run = this.#requireRun(workspaceId, runId);
      const next = mergeRun(run, { pinned, updatedAt: this.now() });
      this.#writeRun(next);
      return next;
    });
  }

  async markExported(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<ObservabilityRunRecord> {
    return this.#transaction(() => {
      const run = this.#requireRun(workspaceId, runId);
      const next = mergeRun(run, {
        exportIds: [...new Set([...run.exportIds, normalizeId(exportId, "exportId")])],
        updatedAt: this.now(),
      });
      this.#writeRun(next);
      return next;
    });
  }

  async queryMetrics(query: ObservabilityMetricQuery): Promise<readonly ObservabilityMetricPoint[]> {
    const rows = this.#db
      .prepare(
        "SELECT value FROM observability_metrics WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at LIMIT ?",
      )
      .all(query.workspaceId, query.from ?? "", query.to ?? "9999", query.limit ?? 10_000) as
      SqliteValueRow[];
    const metrics = rows
      .map((row) => parseJson<ObservabilityMetricPoint>(row.value))
      .filter((point) => (query.names ? query.names.includes(point.name) : true))
      .filter((point) => attributesMatch(point, query.attributes));
    return Object.freeze(metrics);
  }

  async sweepRetention(policy: ObservabilityRetentionPolicy): Promise<ObservabilitySweepResult> {
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          "SELECT workspace_id, run_id, updated_at, status, pinned, active, byte_size, value FROM observability_runs WHERE workspace_id = ? ORDER BY updated_at",
        )
        .all(policy.workspaceId) as SqliteRunRow[];
      const runs = rows.map((row) => parseJson<ObservabilityRunRecord>(row.value));
      let totalBytes = runs.reduce((total, run) => total + run.byteSize, 0);
      const retainedPinnedRunIds: string[] = [];
      const retainedActiveRunIds: string[] = [];
      const deletedRunIds: string[] = [];
      let reclaimedBytes = 0;

      for (const run of runs) {
        const overBytes = policy.maxBytes !== undefined && totalBytes > policy.maxBytes;
        const oldEnough = policy.olderThan !== undefined && run.updatedAt < policy.olderThan;
        if (!overBytes && !oldEnough) {
          continue;
        }

        if (run.pinned) {
          retainedPinnedRunIds.push(run.runId);
          continue;
        }

        if (run.active) {
          retainedActiveRunIds.push(run.runId);
          continue;
        }

        deletedRunIds.push(run.runId);
        reclaimedBytes += run.byteSize;
        totalBytes -= run.byteSize;
        if (policy.dryRun !== true) {
          this.#db
            .prepare("DELETE FROM observability_runs WHERE workspace_id = ? AND run_id = ?")
            .run(run.workspaceId, run.runId);
        }
      }

      return Object.freeze({
        workspaceId: policy.workspaceId,
        deletedRunIds: Object.freeze(deletedRunIds),
        retainedPinnedRunIds: Object.freeze(retainedPinnedRunIds),
        retainedActiveRunIds: Object.freeze(retainedActiveRunIds),
        reclaimedBytes,
        dryRun: policy.dryRun === true,
      });
    });
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  protected async replaceRun(run: ObservabilityRunRecord): Promise<ObservabilityRunRecord> {
    return this.#transaction(() => {
      const next = mergeRun(run, { metricCount: this.#metricCount(run.workspaceId, run.runId) });
      this.#writeRun(next);
      return next;
    });
  }

  protected async recordTraceExtras(
    workspaceId: string,
    runId: string,
    extras: TraceExtras,
  ): Promise<ObservabilityRunRecord> {
    return this.#transaction(() => {
      const run = this.#readRun(workspaceId, runId) ?? createInitialRun(workspaceId, runId, this.now());
      const merged = mergeExtras(this.#readExtras(workspaceId, runId), extras);
      this.#writeExtras(workspaceId, runId, merged);
      const next = mergeRun(run, {
        artifactCount: merged.artifacts.length,
        policyDecisionCount: merged.policyDecisions.length,
        byteSize: run.byteSize + byteSize(extras),
        updatedAt: this.now(),
      });
      this.#writeRun(next);
      return next;
    });
  }

  protected async upsertMetric(point: ObservabilityMetricPoint): Promise<void> {
    this.#transaction(() => {
      this.#upsertMetricSync(point);
      const run = this.#readRun(point.workspaceId, point.runId);
      if (run) {
        this.#writeRun(mergeRun(run, { metricCount: this.#metricCount(point.workspaceId, point.runId) }));
      }
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #readRun(workspaceId: string, runId: string): ObservabilityRunRecord | undefined {
    const row = this.#db
      .prepare("SELECT value FROM observability_runs WHERE workspace_id = ? AND run_id = ?")
      .get(workspaceId, runId) as SqliteValueRow | undefined;
    return row ? parseJson<ObservabilityRunRecord>(row.value) : undefined;
  }

  #requireRun(workspaceId: string, runId: string): ObservabilityRunRecord {
    const run = this.#readRun(workspaceId, runId);
    if (!run) {
      throw new Error(`Run "${runId}" was not found in workspace "${workspaceId}".`);
    }

    return run;
  }

  #writeRun(run: ObservabilityRunRecord): void {
    this.#db
      .prepare(
        "INSERT INTO observability_runs (workspace_id, run_id, updated_at, status, pinned, active, byte_size, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, run_id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, pinned = excluded.pinned, active = excluded.active, byte_size = excluded.byte_size, value = excluded.value",
      )
      .run(
        run.workspaceId,
        run.runId,
        run.updatedAt,
        run.status,
        run.pinned ? 1 : 0,
        run.active ? 1 : 0,
        run.byteSize,
        JSON.stringify(run),
      );
  }

  #readEvent(
    workspaceId: string,
    runId: string,
    eventId: string,
  ): ObservabilityEventRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT value FROM observability_events WHERE workspace_id = ? AND run_id = ? AND event_id = ?",
      )
      .get(workspaceId, runId, eventId) as SqliteValueRow | undefined;
    return row ? parseJson<ObservabilityEventRecord>(row.value) : undefined;
  }

  #writeEvent(event: ObservabilityEventRecord): void {
    this.#db
      .prepare(
        "INSERT INTO observability_events (workspace_id, run_id, event_id, sequence, occurred_at, value) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.workspaceId,
        event.runId,
        event.id,
        event.sequence,
        event.occurredAt,
        JSON.stringify(event),
      );
  }

  #eventCount(workspaceId: string, runId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS count FROM observability_events WHERE workspace_id = ? AND run_id = ?",
      )
      .get(workspaceId, runId) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  #metricCount(workspaceId: string, runId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS count FROM observability_metrics WHERE workspace_id = ? AND run_id = ?",
      )
      .get(workspaceId, runId) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  #upsertMetricSync(point: ObservabilityMetricPoint): void {
    this.#db
      .prepare(
        "INSERT INTO observability_metrics (workspace_id, run_id, metric_id, name, occurred_at, value) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, run_id, metric_id) DO UPDATE SET name = excluded.name, occurred_at = excluded.occurred_at, value = excluded.value",
      )
      .run(point.workspaceId, point.runId, point.id, point.name, point.occurredAt, JSON.stringify(point));
  }

  #readExtras(workspaceId: string, runId: string): TraceExtras {
    const row = this.#db
      .prepare("SELECT value FROM observability_trace_extras WHERE workspace_id = ? AND run_id = ?")
      .get(workspaceId, runId) as SqliteValueRow | undefined;
    return row ? parseJson<TraceExtras>(row.value) : emptyExtras();
  }

  #writeExtras(workspaceId: string, runId: string, extras: TraceExtras): void {
    this.#db
      .prepare(
        "INSERT INTO observability_trace_extras (workspace_id, run_id, value) VALUES (?, ?, ?) ON CONFLICT(workspace_id, run_id) DO UPDATE SET value = excluded.value",
      )
      .run(workspaceId, runId, JSON.stringify(extras));
  }
}

export function canonicalEventToObservabilityEvent(
  workspaceId: string,
  event: CanonicalEvent,
): ObservabilityEventRecord {
  const family = getCanonicalEventFamily(event.name);
  return Object.freeze({
    id: event.eventId,
    workspaceId,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    name: event.name,
    source: "canonical_event",
    summary: event.name,
    payload: summarizePayload(event.data),
    ...(family === undefined ? {} : { family }),
  });
}

function createInitialRun(
  workspaceId: string,
  runId: string,
  now: string,
): ObservabilityRunRecord {
  return Object.freeze({
    workspaceId: normalizeId(workspaceId, "workspaceId"),
    runId: normalizeId(runId, "runId"),
    status: "unknown",
    createdAt: now,
    updatedAt: now,
    eventCount: 0,
    metricCount: 0,
    artifactCount: 0,
    policyDecisionCount: 0,
    byteSize: 0,
    pinned: false,
    active: true,
    exportIds: Object.freeze([]),
    metadata: Object.freeze({
      payloadPosture: "metadata_only",
    }),
  });
}

function updateRunForEvent(
  run: ObservabilityRunRecord,
  event: ObservabilityEventRecord,
  eventCount: number,
  metricCount: number,
): ObservabilityRunRecord {
  const status = statusFromEventName(event.name) ?? run.status;
  return mergeRun(run, {
    status,
    eventCount,
    metricCount,
    byteSize: run.byteSize + byteSize(event),
    active: !TERMINAL_STATUSES.has(status),
    updatedAt: event.occurredAt,
    ...(event.name === "run.started" ? { startedAt: event.occurredAt } : {}),
    ...(TERMINAL_STATUSES.has(status) ? { completedAt: event.occurredAt } : {}),
  });
}

function mergeRun(
  run: ObservabilityRunRecord,
  patch: Partial<ObservabilityRunRecord>,
): ObservabilityRunRecord {
  const startedAt = patch.startedAt ?? run.startedAt;
  const completedAt = patch.completedAt ?? run.completedAt;
  const harnessId = patch.harnessId ?? run.harnessId;
  const rootScopeId = patch.rootScopeId ?? run.rootScopeId;
  const rootAgentId = patch.rootAgentId ?? run.rootAgentId;
  return Object.freeze({
    workspaceId: patch.workspaceId ?? run.workspaceId,
    runId: patch.runId ?? run.runId,
    status: patch.status ?? run.status,
    createdAt: patch.createdAt ?? run.createdAt,
    updatedAt: patch.updatedAt ?? run.updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(harnessId === undefined ? {} : { harnessId }),
    ...(rootScopeId === undefined ? {} : { rootScopeId }),
    ...(rootAgentId === undefined ? {} : { rootAgentId }),
    eventCount: patch.eventCount ?? run.eventCount,
    metricCount: patch.metricCount ?? run.metricCount,
    artifactCount: patch.artifactCount ?? run.artifactCount,
    policyDecisionCount: patch.policyDecisionCount ?? run.policyDecisionCount,
    byteSize: patch.byteSize ?? run.byteSize,
    pinned: patch.pinned ?? run.pinned,
    active: patch.active ?? run.active,
    exportIds: Object.freeze([...(patch.exportIds ?? run.exportIds)]),
    metadata: Object.freeze({
      ...run.metadata,
      ...(patch.metadata ?? {}),
    }),
  });
}

function statusFromEventName(name: string): ObservabilityRunStatus | undefined {
  if (name === "run.created") {
    return "created";
  }
  if (name === "run.started") {
    return "running";
  }
  if (name === "run.completed") {
    return "succeeded";
  }
  if (name === "run.failed") {
    return "failed";
  }
  if (name === "run.cancelled") {
    return "cancelled";
  }
  return undefined;
}

function mapRunStatus(status: AgentHarnessRunResult["envelope"]["status"]): ObservabilityRunStatus {
  return status;
}

function emptyExtras(): TraceExtras {
  return Object.freeze({
    projections: Object.freeze([]),
    artifacts: Object.freeze([]),
    policyDecisions: Object.freeze([]),
    traceEvents: Object.freeze([]),
  });
}

function mergeExtras(current: TraceExtras, incoming: TraceExtras): TraceExtras {
  return Object.freeze({
    projections: Object.freeze(dedupeById([...current.projections, ...incoming.projections])),
    artifacts: Object.freeze(dedupeById([...current.artifacts, ...incoming.artifacts])),
    policyDecisions: Object.freeze(dedupeById([...current.policyDecisions, ...incoming.policyDecisions])),
    traceEvents: Object.freeze(dedupeById([...current.traceEvents, ...incoming.traceEvents])),
  });
}

function dedupeById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function attributesMatch(
  point: ObservabilityMetricPoint,
  attributes?: Readonly<Record<string, string>>,
): boolean {
  if (!attributes) {
    return true;
  }

  return Object.entries(attributes).every(([key, value]) => point.attributes[key] === value);
}

function compareEvents(left: ObservabilityEventRecord, right: ObservabilityEventRecord): number {
  return left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt);
}

function stateKey(workspaceId: string, runId: string): string {
  return `${normalizeId(workspaceId, "workspaceId")}\u0000${normalizeId(runId, "runId")}`;
}

function normalizeId(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Expected a non-empty ${name}.`);
  }
  return normalized;
}

function normalizeSqlitePath(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Expected a non-empty SQLite path.");
  }
  return normalized === ":memory:" ? normalized : path.resolve(normalized);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function migrateSqliteObservability(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observability_runs (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      active INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, run_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_observability_runs_workspace_updated
    ON observability_runs (workspace_id, updated_at);

    CREATE TABLE IF NOT EXISTS observability_events (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, run_id, event_id),
      FOREIGN KEY (workspace_id, run_id)
        REFERENCES observability_runs (workspace_id, run_id)
        ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_observability_events_run_sequence
    ON observability_events (workspace_id, run_id, sequence);

    CREATE TABLE IF NOT EXISTS observability_metrics (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      name TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, run_id, metric_id),
      FOREIGN KEY (workspace_id, run_id)
        REFERENCES observability_runs (workspace_id, run_id)
        ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_observability_metrics_query
    ON observability_metrics (workspace_id, name, occurred_at);

    CREATE TABLE IF NOT EXISTS observability_trace_extras (
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, run_id),
      FOREIGN KEY (workspace_id, run_id)
        REFERENCES observability_runs (workspace_id, run_id)
        ON DELETE CASCADE
    ) STRICT;
  `);
}
