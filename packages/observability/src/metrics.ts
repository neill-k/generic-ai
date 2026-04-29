import type { CanonicalEventFamily } from "@generic-ai/sdk";
import type {
  ObservabilityEventRecord,
  ObservabilityMetricDefinition,
  ObservabilityMetricPoint,
  ObservabilityRunRecord,
} from "./types.js";

const CORRELATION_ONLY_ATTRIBUTES = [
  "run_id",
  "runId",
  "session_id",
  "sessionId",
  "event_id",
  "eventId",
  "trace_id",
  "traceId",
  "prompt",
  "output",
  "file_path",
  "filePath",
  "user_id",
  "userId",
] as const;

export const observabilityMetricCatalog = Object.freeze([
  {
    name: "generic_ai.run.events.count",
    unit: "count",
    description: "Count of ingested run events grouped by bounded event family.",
    sourceEvents: ["canonical events", "harness projections", "trace events"],
    allowedAttributes: [
      { name: "workspace_id", description: "Stable workspace identity." },
      { name: "event_family", description: "Bounded event family." },
      { name: "source", description: "Bounded ingestion source." },
    ],
    rejectedAttributes: CORRELATION_ONLY_ATTRIBUTES,
  },
  {
    name: "generic_ai.run.duration.ms",
    unit: "milliseconds",
    description: "Terminal run duration when created/started and completed timestamps are known.",
    sourceEvents: ["run completed", "run failed", "run cancelled", "harness run result"],
    allowedAttributes: [
      { name: "workspace_id", description: "Stable workspace identity." },
      { name: "status", description: "Bounded terminal run status." },
    ],
    rejectedAttributes: CORRELATION_ONLY_ATTRIBUTES,
  },
  {
    name: "generic_ai.run.bytes",
    unit: "bytes",
    description: "Stored metadata bytes for a run after redaction and payload omission.",
    sourceEvents: ["repository accounting"],
    allowedAttributes: [
      { name: "workspace_id", description: "Stable workspace identity." },
      { name: "status", description: "Bounded run status." },
    ],
    rejectedAttributes: CORRELATION_ONLY_ATTRIBUTES,
  },
  {
    name: "generic_ai.policy.decisions.count",
    unit: "count",
    description: "Count of policy decisions grouped by bounded effect and decision.",
    sourceEvents: ["policy.decision", "harness policy decisions"],
    allowedAttributes: [
      { name: "workspace_id", description: "Stable workspace identity." },
      { name: "effect", description: "Bounded policy effect." },
      { name: "decision", description: "Bounded policy decision." },
    ],
    rejectedAttributes: CORRELATION_ONLY_ATTRIBUTES,
  },
  {
    name: "generic_ai.trace.completeness.ratio",
    unit: "ratio",
    description: "Evidence completeness ratio derived from event, projection, and artifact presence.",
    sourceEvents: ["trace assembly"],
    allowedAttributes: [
      { name: "workspace_id", description: "Stable workspace identity." },
      { name: "status", description: "Bounded run status." },
    ],
    rejectedAttributes: CORRELATION_ONLY_ATTRIBUTES,
  },
] satisfies readonly ObservabilityMetricDefinition[]);

const metricCatalogByName = new Map(observabilityMetricCatalog.map((metric) => [metric.name, metric]));

export function getObservabilityMetricCatalog(): readonly ObservabilityMetricDefinition[] {
  return observabilityMetricCatalog;
}

export function assertMetricAttributesAreBounded(point: ObservabilityMetricPoint): void {
  const definition = metricCatalogByName.get(point.name);
  if (!definition) {
    throw new Error(`Unknown observability metric "${point.name}".`);
  }

  const allowed = new Set(definition.allowedAttributes.map((attribute) => attribute.name));
  for (const key of Object.keys(point.attributes)) {
    if (!allowed.has(key)) {
      throw new Error(`Metric "${point.name}" uses unapproved attribute "${key}".`);
    }
  }
}

export function metricPoint(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly name: string;
  readonly value: number;
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly evidenceEventIds?: readonly string[];
}): ObservabilityMetricPoint {
  const definition = metricCatalogByName.get(input.name);
  if (!definition) {
    throw new Error(`Unknown observability metric "${input.name}".`);
  }

  const point = Object.freeze({
    id: stableMetricId(input),
    workspaceId: input.workspaceId,
    runId: input.runId,
    name: input.name,
    unit: definition.unit,
    value: input.value,
    occurredAt: input.occurredAt,
    attributes: Object.freeze({ ...input.attributes }),
    evidenceEventIds: Object.freeze([...(input.evidenceEventIds ?? [])]),
  });
  assertMetricAttributesAreBounded(point);
  return point;
}

export function deriveEventCountMetric(event: ObservabilityEventRecord): ObservabilityMetricPoint {
  return metricPoint({
    workspaceId: event.workspaceId,
    runId: event.runId,
    name: "generic_ai.run.events.count",
    value: 1,
    occurredAt: event.occurredAt,
    attributes: {
      workspace_id: event.workspaceId,
      event_family: event.family ?? "unknown",
      source: event.source,
    },
    evidenceEventIds: [event.id],
  });
}

export function deriveRunMetrics(run: ObservabilityRunRecord): readonly ObservabilityMetricPoint[] {
  const metrics: ObservabilityMetricPoint[] = [
    metricPoint({
      workspaceId: run.workspaceId,
      runId: run.runId,
      name: "generic_ai.run.bytes",
      value: run.byteSize,
      occurredAt: run.updatedAt,
      attributes: {
        workspace_id: run.workspaceId,
        status: run.status,
      },
    }),
  ];
  const duration = runDurationMs(run);
  if (duration !== undefined) {
    metrics.push(
      metricPoint({
        workspaceId: run.workspaceId,
        runId: run.runId,
        name: "generic_ai.run.duration.ms",
        value: duration,
        occurredAt: run.completedAt ?? run.updatedAt,
        attributes: {
          workspace_id: run.workspaceId,
          status: run.status,
        },
      }),
    );
  }

  metrics.push(
    metricPoint({
      workspaceId: run.workspaceId,
      runId: run.runId,
      name: "generic_ai.trace.completeness.ratio",
      value: run.eventCount > 0 ? 1 : 0,
      occurredAt: run.updatedAt,
      attributes: {
        workspace_id: run.workspaceId,
        status: run.status,
      },
    }),
  );

  return Object.freeze(metrics);
}

export function normalizeEventFamily(family: CanonicalEventFamily | undefined): string {
  return family ?? "unknown";
}

function runDurationMs(run: ObservabilityRunRecord): number | undefined {
  const start = run.startedAt ?? run.createdAt;
  const end = run.completedAt;
  if (!end) {
    return undefined;
  }

  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function stableMetricId(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly name: string;
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly evidenceEventIds?: readonly string[];
}): string {
  const attributes = Object.entries(input.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const evidence = [...(input.evidenceEventIds ?? [])].sort().join(",");
  return `${input.workspaceId}:${input.runId}:${input.name}:${input.occurredAt}:${attributes}:${evidence}`;
}
