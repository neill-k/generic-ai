import type {
  ObservabilityEventRecord,
  ObservabilityReport,
  ObservabilityTraceRecord,
} from "./types.js";

export type ProvenanceJsonValue =
  | string
  | number
  | boolean
  | null
  | ProvenanceJsonObject
  | readonly ProvenanceJsonValue[];

export interface ProvenanceJsonObject {
  readonly [key: string]: ProvenanceJsonValue;
}

export type ProvenanceRecordKind = "entity" | "activity" | "agent" | "derivation";

export interface ProvenanceEntity {
  readonly kind: "entity";
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly generatedAtTime?: string;
  readonly wasGeneratedBy?: string;
  readonly atLocation?: string;
  readonly sha256?: string;
  readonly attributes: ProvenanceJsonObject;
}

export interface ProvenanceActivity {
  readonly kind: "activity";
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly startedAtTime?: string;
  readonly endedAtTime?: string;
  readonly wasAssociatedWith: readonly string[];
  readonly attributes: ProvenanceJsonObject;
}

export interface ProvenanceAgent {
  readonly kind: "agent";
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly attributes: ProvenanceJsonObject;
}

export interface ProvenanceDerivation {
  readonly kind: "derivation";
  readonly id: string;
  readonly generatedEntity: string;
  readonly usedEntity: string;
  readonly activity?: string;
  readonly role: string;
  readonly attributes: ProvenanceJsonObject;
}

export interface ProvenanceBundle {
  readonly kind: "generic-ai.provenance-bundle";
  readonly schemaVersion: "prov-jsonld-like.v0.1";
  readonly "@context": ProvenanceJsonObject;
  readonly id: string;
  readonly generatedAt: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly entities: readonly ProvenanceEntity[];
  readonly activities: readonly ProvenanceActivity[];
  readonly agents: readonly ProvenanceAgent[];
  readonly derivations: readonly ProvenanceDerivation[];
}

export interface CreateProvenanceBundleInput {
  readonly trace: ObservabilityTraceRecord;
  readonly report?: ObservabilityReport;
  readonly bundleId?: string;
  readonly generatedAt?: string;
}

interface ProvenanceBuilder {
  readonly entities: Map<string, ProvenanceEntity>;
  readonly activities: Map<string, ProvenanceActivity>;
  readonly agents: Map<string, ProvenanceAgent>;
  readonly derivations: Map<string, ProvenanceDerivation>;
  readonly entityByEvidenceRef: Map<string, string>;
}

const context: ProvenanceJsonObject = Object.freeze({
  prov: "http://www.w3.org/ns/prov#",
  genericAi: "https://generic-ai.local/ns/provenance#",
  entity: "prov:Entity",
  activity: "prov:Activity",
  agent: "prov:Agent",
  wasDerivedFrom: "prov:wasDerivedFrom",
  wasGeneratedBy: "prov:wasGeneratedBy",
  wasAssociatedWith: "prov:wasAssociatedWith",
});

export function createProvenanceBundle(input: CreateProvenanceBundleInput): ProvenanceBundle {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const trace = input.trace;
  const builder = createBuilder();
  const runActivityId = provenanceId("activity", "run", trace.run.workspaceId, trace.run.runId);
  const runtimeAgentId = provenanceId("agent", "runtime", trace.run.runId);
  const reportAgentId = provenanceId("agent", "observability", "reporter");
  const runEntityId = provenanceId("entity", "run", trace.run.workspaceId, trace.run.runId);

  addAgent(builder, {
    kind: "agent",
    id: runtimeAgentId,
    type: "generic-ai.runtime",
    label: "Generic AI runtime",
    attributes: compactAttributes({
      harnessId: trace.run.harnessId ?? null,
      rootScopeId: trace.run.rootScopeId ?? null,
      rootAgentId: trace.run.rootAgentId ?? null,
    }),
  });
  addAgent(builder, {
    kind: "agent",
    id: reportAgentId,
    type: "generic-ai.observability",
    label: "Generic AI observability",
    attributes: Object.freeze({ package: "@generic-ai/observability" }),
  });
  if (trace.run.rootAgentId !== undefined) {
    addAgent(builder, {
      kind: "agent",
      id: provenanceId("agent", "root", trace.run.rootAgentId),
      type: "generic-ai.harness-agent",
      label: trace.run.rootAgentId,
      attributes: Object.freeze({ runId: trace.run.runId }),
    });
  }

  addActivity(builder, {
    kind: "activity",
    id: runActivityId,
    type: "generic-ai.run",
    label: `Run ${trace.run.runId}`,
    startedAtTime: trace.run.startedAt ?? trace.run.createdAt,
    ...(trace.run.completedAt === undefined ? {} : { endedAtTime: trace.run.completedAt }),
    wasAssociatedWith: Object.freeze([runtimeAgentId]),
    attributes: compactAttributes({
      status: trace.run.status,
      active: trace.run.active,
      eventCount: trace.run.eventCount,
      metricCount: trace.run.metricCount,
      artifactCount: trace.run.artifactCount,
      policyDecisionCount: trace.run.policyDecisionCount,
    }),
  });
  addEntity(builder, {
    kind: "entity",
    id: runEntityId,
    type: "generic-ai.run-record",
    label: `Run record ${trace.run.runId}`,
    generatedAtTime: trace.run.updatedAt,
    wasGeneratedBy: runActivityId,
    attributes: compactAttributes({
      workspaceId: trace.run.workspaceId,
      runId: trace.run.runId,
      status: trace.run.status,
      payloadPosture: valueFromMetadata(trace.run.metadata, "payloadPosture"),
    }),
  });
  builder.entityByEvidenceRef.set(trace.run.runId, runEntityId);

  for (const event of trace.events) {
    addEventEvidence(builder, event, runActivityId);
    addDerivation(builder, entityIdForEvent(event), runEntityId, runActivityId, "run-event");
  }

  for (const projection of trace.projections) {
    const activityId = provenanceId("activity", "projection", projection.id);
    const entityId = provenanceId("entity", "projection", projection.id);
    addActivity(builder, {
      kind: "activity",
      id: activityId,
      type: "generic-ai.harness-projection",
      label: projection.type,
      startedAtTime: projection.occurredAt,
      wasAssociatedWith: Object.freeze([runtimeAgentId]),
      attributes: compactAttributes({
        sequence: projection.sequence,
        eventName: projection.eventName,
        roleId: projection.roleId ?? null,
        toolName: projection.toolName ?? null,
      }),
    });
    addEntity(builder, {
      kind: "entity",
      id: entityId,
      type: "generic-ai.harness-projection",
      label: projection.summary,
      generatedAtTime: projection.occurredAt,
      wasGeneratedBy: activityId,
      attributes: compactAttributes({
        eventName: projection.eventName,
        projectionType: projection.type,
      }),
    });
    builder.entityByEvidenceRef.set(projection.id, entityId);
    addDerivation(
      builder,
      entityId,
      matchingEventEntityId(trace.events, projection.sequence, projection.eventName) ?? runEntityId,
      activityId,
      "projected-from",
    );
  }

  for (const artifact of trace.artifacts) {
    const activityId = provenanceId("activity", "artifact", artifact.id);
    const entityId = provenanceId("entity", "artifact", artifact.id);
    addActivity(builder, {
      kind: "activity",
      id: activityId,
      type: "generic-ai.artifact-created",
      label: `Artifact ${artifact.id}`,
      wasAssociatedWith: Object.freeze([runtimeAgentId]),
      attributes: compactAttributes({
        kind: artifact.kind,
        ownerId: artifact.ownerId ?? null,
        namespace: artifact.namespace ?? null,
      }),
    });
    addEntity(builder, {
      kind: "entity",
      id: entityId,
      type: "generic-ai.artifact",
      label: artifact.description ?? artifact.id,
      wasGeneratedBy: activityId,
      atLocation: artifact.uri,
      ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
      attributes: compactAttributes({
        kind: artifact.kind,
        localPath: artifact.localPath ?? null,
        ownerId: artifact.ownerId ?? null,
        namespace: artifact.namespace ?? null,
      }),
    });
    builder.entityByEvidenceRef.set(artifact.id, entityId);
    addDerivation(builder, entityId, runEntityId, activityId, "run-artifact");
  }

  for (const decision of trace.policyDecisions) {
    const actorAgentId = provenanceId("agent", "policy-actor", decision.actorId);
    const activityId = provenanceId("activity", "policy", decision.id);
    const entityId = provenanceId("entity", "policy", decision.id);
    addAgent(builder, {
      kind: "agent",
      id: actorAgentId,
      type: "generic-ai.policy-actor",
      label: decision.actorId,
      attributes: Object.freeze({ runId: decision.runId }),
    });
    addActivity(builder, {
      kind: "activity",
      id: activityId,
      type: "generic-ai.policy-evaluation",
      label: `Policy decision ${decision.id}`,
      wasAssociatedWith: Object.freeze([actorAgentId]),
      attributes: compactAttributes({
        action: decision.action,
        effect: decision.effect,
        decision: decision.decision,
        policyRef: decision.policyRef ?? null,
        grantRef: decision.grantRef ?? null,
      }),
    });
    addEntity(builder, {
      kind: "entity",
      id: entityId,
      type: "generic-ai.policy-decision",
      label: decision.reason,
      wasGeneratedBy: activityId,
      attributes: compactAttributes({
        action: decision.action,
        effect: decision.effect,
        decision: decision.decision,
        approvalState: decision.approvalState ?? null,
      }),
    });
    builder.entityByEvidenceRef.set(decision.id, entityId);
    for (const evidenceRef of decision.evidenceRefs) {
      const usedEntity = builder.entityByEvidenceRef.get(evidenceRef);
      if (usedEntity !== undefined) {
        addDerivation(builder, entityId, usedEntity, activityId, "policy-evidence");
      }
    }
  }

  for (const traceEvent of trace.traceEvents) {
    const agentId =
      traceEvent.actorId === undefined
        ? runtimeAgentId
        : provenanceId("agent", "trace-actor", traceEvent.actorId);
    if (traceEvent.actorId !== undefined) {
      addAgent(builder, {
        kind: "agent",
        id: agentId,
        type: "generic-ai.trace-actor",
        label: traceEvent.actorId,
        attributes: compactAttributes({
          packageId: traceEvent.packageId ?? null,
          protocolId: traceEvent.protocolId ?? null,
        }),
      });
    }
    const activityId = provenanceId("activity", "trace-event", traceEvent.id);
    const entityId = provenanceId("entity", "trace-event", traceEvent.id);
    addActivity(builder, {
      kind: "activity",
      id: activityId,
      type: `generic-ai.trace.${traceEvent.type}`,
      label: traceEvent.type,
      startedAtTime: traceEvent.timestamp,
      wasAssociatedWith: Object.freeze([agentId]),
      attributes: compactAttributes({
        sequence: traceEvent.sequence,
        candidateId: traceEvent.candidateId ?? null,
        trialId: traceEvent.trialId ?? null,
        artifactId: traceEvent.artifactId ?? null,
        policyDecisionId: traceEvent.policyDecisionId ?? null,
        parentEventId: traceEvent.parentEventId ?? null,
        causedByEventId: traceEvent.causedByEventId ?? null,
        latencyMs: traceEvent.latencyMs ?? null,
        costUsd: traceEvent.costUsd ?? null,
      }),
    });
    addEntity(builder, {
      kind: "entity",
      id: entityId,
      type: "generic-ai.trace-event",
      label: traceEvent.summary,
      generatedAtTime: traceEvent.timestamp,
      wasGeneratedBy: activityId,
      attributes: compactAttributes({
        traceType: traceEvent.type,
        sequence: traceEvent.sequence,
      }),
    });
    builder.entityByEvidenceRef.set(traceEvent.id, entityId);
    if (traceEvent.causedByEventId !== undefined) {
      const usedEntity = builder.entityByEvidenceRef.get(traceEvent.causedByEventId);
      if (usedEntity !== undefined) {
        addDerivation(builder, entityId, usedEntity, activityId, "caused-by");
      }
    }
    if (traceEvent.artifactId !== undefined) {
      const artifactEntity = builder.entityByEvidenceRef.get(traceEvent.artifactId);
      if (artifactEntity !== undefined) {
        addDerivation(builder, artifactEntity, entityId, activityId, "trace-artifact");
      }
    }
  }

  if (input.report !== undefined) {
    addReportEvidence(builder, input.report, generatedAt, reportAgentId, runEntityId);
  }

  return Object.freeze({
    kind: "generic-ai.provenance-bundle",
    schemaVersion: "prov-jsonld-like.v0.1",
    "@context": context,
    id:
      input.bundleId ?? provenanceId("bundle", trace.run.workspaceId, trace.run.runId, generatedAt),
    generatedAt,
    workspaceId: trace.run.workspaceId,
    runId: trace.run.runId,
    entities: Object.freeze([...builder.entities.values()]),
    activities: Object.freeze([...builder.activities.values()]),
    agents: Object.freeze([...builder.agents.values()]),
    derivations: Object.freeze([...builder.derivations.values()]),
  });
}

export function serializeProvenanceBundle(bundle: ProvenanceBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function createBuilder(): ProvenanceBuilder {
  return {
    entities: new Map(),
    activities: new Map(),
    agents: new Map(),
    derivations: new Map(),
    entityByEvidenceRef: new Map(),
  };
}

function addEventEvidence(
  builder: ProvenanceBuilder,
  event: ObservabilityEventRecord,
  runActivityId: string,
): void {
  const sourceAgentId = provenanceId("agent", "event-source", event.source);
  const activityId = provenanceId("activity", "event", event.id);
  const entityId = entityIdForEvent(event);
  addAgent(builder, {
    kind: "agent",
    id: sourceAgentId,
    type: "generic-ai.event-source",
    label: event.source,
    attributes: compactAttributes({ family: event.family ?? null }),
  });
  addActivity(builder, {
    kind: "activity",
    id: activityId,
    type: "generic-ai.event-emission",
    label: event.name,
    startedAtTime: event.occurredAt,
    wasAssociatedWith: Object.freeze([sourceAgentId]),
    attributes: compactAttributes({
      source: event.source,
      sequence: event.sequence,
      family: event.family ?? null,
      runActivityId,
    }),
  });
  addEntity(builder, {
    kind: "entity",
    id: entityId,
    type: "generic-ai.event",
    label: event.summary,
    generatedAtTime: event.occurredAt,
    wasGeneratedBy: activityId,
    attributes: compactAttributes({
      name: event.name,
      source: event.source,
      sequence: event.sequence,
      family: event.family ?? null,
      payloadPosture: event.payload.posture,
      payloadKind: event.payload.kind,
      payloadByteSize: event.payload.byteSize,
      payloadRedacted: event.payload.redacted,
      payloadTruncated: event.payload.truncated,
    }),
  });
  builder.entityByEvidenceRef.set(event.id, entityId);
}

function addReportEvidence(
  builder: ProvenanceBuilder,
  report: ObservabilityReport,
  generatedAt: string,
  reportAgentId: string,
  runEntityId: string,
): void {
  const activityId = provenanceId("activity", "report", report.runId);
  const reportEntityId = provenanceId("entity", "report", report.runId);
  addActivity(builder, {
    kind: "activity",
    id: activityId,
    type: "generic-ai.report-generation",
    label: `Report ${report.runId}`,
    startedAtTime: generatedAt,
    endedAtTime: generatedAt,
    wasAssociatedWith: Object.freeze([reportAgentId]),
    attributes: compactAttributes({
      status: report.status,
      observationCount: report.observations.length,
      inferenceCount: report.inferences.length,
      insufficientEvidenceCount: report.insufficientEvidence.length,
    }),
  });
  addEntity(builder, {
    kind: "entity",
    id: reportEntityId,
    type: "generic-ai.observability-report",
    label: `Observability report ${report.runId}`,
    generatedAtTime: generatedAt,
    wasGeneratedBy: activityId,
    attributes: compactAttributes({
      status: report.status,
      eventCount: report.evidence.eventCount,
      metricCount: report.evidence.metricCount,
      artifactCount: report.evidence.artifactCount,
      policyDecisionCount: report.evidence.policyDecisionCount,
    }),
  });
  addDerivation(builder, reportEntityId, runEntityId, activityId, "report-source");

  report.observations.forEach((observation, index) => {
    addReportLineEntity(builder, {
      reportEntityId,
      activityId,
      generatedAt,
      type: "generic-ai.report-observation",
      role: "report-observation",
      line: observation,
      index,
      runId: report.runId,
    });
  });
  report.inferences.forEach((inference, index) => {
    addReportLineEntity(builder, {
      reportEntityId,
      activityId,
      generatedAt,
      type: "generic-ai.report-inference",
      role: "report-inference",
      line: inference,
      index,
      runId: report.runId,
    });
  });
  report.insufficientEvidence.forEach((gap, index) => {
    addReportLineEntity(builder, {
      reportEntityId,
      activityId,
      generatedAt,
      type: "generic-ai.insufficient-evidence",
      role: "insufficient-evidence",
      line: gap,
      index,
      runId: report.runId,
    });
  });
}

function addReportLineEntity(
  builder: ProvenanceBuilder,
  input: {
    readonly reportEntityId: string;
    readonly activityId: string;
    readonly generatedAt: string;
    readonly type: string;
    readonly role: string;
    readonly line: string;
    readonly index: number;
    readonly runId: string;
  },
): void {
  const entityId = provenanceId("entity", input.role, input.runId, String(input.index + 1));
  addEntity(builder, {
    kind: "entity",
    id: entityId,
    type: input.type,
    label: input.line,
    generatedAtTime: input.generatedAt,
    wasGeneratedBy: input.activityId,
    attributes: Object.freeze({
      index: input.index + 1,
      text: input.line,
    }),
  });
  addDerivation(builder, entityId, input.reportEntityId, input.activityId, input.role);
}

function addEntity(builder: ProvenanceBuilder, entity: ProvenanceEntity): void {
  builder.entities.set(entity.id, Object.freeze(entity));
}

function addActivity(builder: ProvenanceBuilder, activity: ProvenanceActivity): void {
  builder.activities.set(activity.id, Object.freeze(activity));
}

function addAgent(builder: ProvenanceBuilder, agent: ProvenanceAgent): void {
  builder.agents.set(agent.id, Object.freeze(agent));
}

function addDerivation(
  builder: ProvenanceBuilder,
  generatedEntity: string,
  usedEntity: string,
  activity: string | undefined,
  role: string,
): void {
  const id = provenanceId("derivation", generatedEntity, usedEntity, role);
  builder.derivations.set(
    id,
    Object.freeze({
      kind: "derivation",
      id,
      generatedEntity,
      usedEntity,
      ...(activity === undefined ? {} : { activity }),
      role,
      attributes: Object.freeze({ role }),
    }),
  );
}

function matchingEventEntityId(
  events: readonly ObservabilityEventRecord[],
  sequence: number,
  eventName: string,
): string | undefined {
  const event = events.find(
    (candidate) => candidate.sequence === sequence && candidate.name === eventName,
  );
  return event === undefined ? undefined : entityIdForEvent(event);
}

function entityIdForEvent(event: ObservabilityEventRecord): string {
  return provenanceId("entity", "event", event.id);
}

function provenanceId(...parts: readonly string[]): string {
  return `urn:generic-ai:${parts.map(sanitizeIdPart).join(":")}`;
}

function sanitizeIdPart(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length === 0 ? "blank" : sanitized;
}

function compactAttributes(
  attributes: Readonly<Record<string, ProvenanceJsonValue | undefined>>,
): ProvenanceJsonObject {
  const compacted: Record<string, ProvenanceJsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      compacted[key] = value;
    }
  }
  return Object.freeze(compacted);
}

function valueFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): ProvenanceJsonValue | undefined {
  const value = metadata[key];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  return undefined;
}
