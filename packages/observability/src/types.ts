import type {
  AgentHarnessArtifactRef,
  AgentHarnessEventProjection,
  AgentHarnessRunResult,
  CanonicalEvent,
  CanonicalEventFamily,
  JsonObject,
  PolicyDecisionRecord,
  TraceEvent,
} from "@generic-ai/sdk";

export type ObservabilityRunStatus =
  | "created"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type ObservabilityPayloadPosture = "metadata_only" | "redacted" | "none";

export type ObservabilityEventSource =
  | "canonical_event"
  | "harness_projection"
  | "trace_event"
  | "system";

export interface ObservabilityPayloadSummary {
  readonly posture: ObservabilityPayloadPosture;
  readonly kind: string;
  readonly byteSize: number;
  readonly summary: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly metadata: JsonObject;
}

export interface ObservabilityEventRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly name: string;
  readonly family?: CanonicalEventFamily | "projection" | "trace" | "system";
  readonly source: ObservabilityEventSource;
  readonly summary: string;
  readonly payload: ObservabilityPayloadSummary;
}

export interface ObservabilityRunRecord {
  readonly workspaceId: string;
  readonly runId: string;
  readonly status: ObservabilityRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly harnessId?: string;
  readonly rootScopeId?: string;
  readonly rootAgentId?: string;
  readonly eventCount: number;
  readonly metricCount: number;
  readonly artifactCount: number;
  readonly policyDecisionCount: number;
  readonly byteSize: number;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly exportIds: readonly string[];
  readonly metadata: JsonObject;
}

export interface ObservabilityMetricAttributeSpec {
  readonly name: string;
  readonly description: string;
  readonly maxValues?: number;
}

export interface ObservabilityMetricDefinition {
  readonly name: string;
  readonly unit: "count" | "milliseconds" | "ratio" | "bytes";
  readonly description: string;
  readonly sourceEvents: readonly string[];
  readonly allowedAttributes: readonly ObservabilityMetricAttributeSpec[];
  readonly rejectedAttributes: readonly string[];
}

export interface ObservabilityMetricPoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly name: string;
  readonly unit: ObservabilityMetricDefinition["unit"];
  readonly value: number;
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly evidenceEventIds: readonly string[];
}

export interface ObservabilityTraceRecord {
  readonly run: ObservabilityRunRecord;
  readonly events: readonly ObservabilityEventRecord[];
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly artifacts: readonly AgentHarnessArtifactRef[];
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly traceEvents: readonly TraceEvent[];
}

export interface ObservabilityReport {
  readonly kind: "generic-ai.observability-report";
  readonly generatedAt: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly status: ObservabilityRunStatus;
  readonly observations: readonly string[];
  readonly inferences: readonly string[];
  readonly evidence: {
    readonly eventCount: number;
    readonly metricCount: number;
    readonly artifactCount: number;
    readonly policyDecisionCount: number;
  };
  readonly insufficientEvidence: readonly string[];
}

export interface ObservabilityRunListFilter {
  readonly workspaceId: string;
  readonly status?: ObservabilityRunStatus;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export interface ObservabilityEventListFilter {
  readonly workspaceId: string;
  readonly runId: string;
  readonly fromSequence?: number;
  readonly limit?: number;
}

export interface ObservabilityMetricQuery {
  readonly workspaceId: string;
  readonly names?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly limit?: number;
}

export interface ObservabilityRetentionPolicy {
  readonly workspaceId: string;
  readonly maxBytes?: number;
  readonly olderThan?: string;
  readonly dryRun?: boolean;
}

export interface ObservabilitySweepResult {
  readonly workspaceId: string;
  readonly deletedRunIds: readonly string[];
  readonly retainedPinnedRunIds: readonly string[];
  readonly retainedActiveRunIds: readonly string[];
  readonly reclaimedBytes: number;
  readonly dryRun: boolean;
}

export interface ObservabilityAppendEventResult {
  readonly event: ObservabilityEventRecord;
  readonly run: ObservabilityRunRecord;
  readonly inserted: boolean;
}

export interface ObservabilityIngestRunResultInput<TOutput = string> {
  readonly workspaceId: string;
  readonly result: AgentHarnessRunResult<TOutput>;
}

export interface ObservabilityAppendEventInput {
  readonly workspaceId: string;
  readonly event: ObservabilityEventRecord;
}

export interface ObservabilityRepository {
  appendEvent(input: ObservabilityAppendEventInput): Promise<ObservabilityAppendEventResult>;
  ingestRunResult<TOutput = string>(
    input: ObservabilityIngestRunResultInput<TOutput>,
  ): Promise<ObservabilityRunRecord>;
  listRuns(filter: ObservabilityRunListFilter): Promise<readonly ObservabilityRunRecord[]>;
  getRun(workspaceId: string, runId: string): Promise<ObservabilityRunRecord | undefined>;
  listEvents(filter: ObservabilityEventListFilter): Promise<readonly ObservabilityEventRecord[]>;
  getTrace(workspaceId: string, runId: string): Promise<ObservabilityTraceRecord | undefined>;
  setPin(workspaceId: string, runId: string, pinned: boolean): Promise<ObservabilityRunRecord>;
  markExported(
    workspaceId: string,
    runId: string,
    exportId: string,
  ): Promise<ObservabilityRunRecord>;
  queryMetrics(query: ObservabilityMetricQuery): Promise<readonly ObservabilityMetricPoint[]>;
  sweepRetention(policy: ObservabilityRetentionPolicy): Promise<ObservabilitySweepResult>;
  close?(): void;
}

export interface ObservabilityIngestionSource {
  readonly id: string;
  subscribe(listener: (event: CanonicalEvent) => void | Promise<void>): Promise<{ close(): void }>;
}
