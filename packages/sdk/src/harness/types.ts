import type { Awaitable, JsonObject, JsonValue } from "../contracts/shared.js";

export const HARNESS_SCHEMA_VERSION = "0.1" as const;

export type HarnessSchemaVersion = typeof HARNESS_SCHEMA_VERSION;
export type DiagnosticSeverity = "error" | "warning";
export type ObjectiveClass = "coding" | "research" | "operations" | "analysis" | "custom";
export type PolicyEffect = "allow" | "deny" | "require_approval" | "redact" | "rewrite";
export type ApprovalState = "not_required" | "pending" | "approved" | "rejected" | "expired";
export type ProtocolTerminalState = "blocked" | "idle" | "ready" | "done" | "failed";
export type RecommendationBoundary = "recommended" | "not_recommended" | "insufficient_evidence";

export interface CompileDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface PackageUseSpec {
  readonly id: string;
  readonly package: string;
  readonly version?: string;
  readonly compatibility?: readonly string[];
  readonly config?: JsonObject;
}

export interface CapabilitySpec {
  readonly id: string;
  readonly kind:
    | "tool"
    | "memory"
    | "protocol"
    | "grader"
    | "trace-exporter"
    | "report-renderer"
    | "policy"
    | "runtime"
    | "custom";
  readonly packageRef: string;
  readonly description?: string;
  readonly grants?: readonly CapabilityGrant[];
  readonly schema?: JsonObject;
}

export interface AgentSpec {
  readonly id: string;
  readonly role: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly packageRefs?: readonly string[];
  readonly capabilityRefs?: readonly string[];
  readonly readableSpaces?: readonly string[];
  readonly writableSpaces?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface SpaceSpec {
  readonly id: string;
  readonly kind: "workspace" | "message-thread" | "memory" | "artifact-store" | "scratch" | "custom";
  readonly description?: string;
  readonly visibility?: "private" | "shared" | "public";
  readonly ownerAgentRef?: string;
}

export interface RelationshipSpec {
  readonly id: string;
  readonly kind: "delegates_to" | "reviews" | "coordinates_with" | "reports_to" | "blocks" | "custom";
  readonly fromAgentRef: string;
  readonly toAgentRef: string;
  readonly description?: string;
}

export interface ProtocolBindingSpec {
  readonly id: string;
  readonly protocol: string;
  readonly packageRef: string;
  readonly actorRefs: readonly string[];
  readonly config?: JsonObject;
}

export interface ResourceSelector {
  readonly kind:
    | "tool"
    | "space"
    | "artifact"
    | "package"
    | "memory"
    | "trace"
    | "report"
    | "sandbox"
    | "custom";
  readonly id?: string;
  readonly pattern?: string;
}

export interface PolicyCondition {
  readonly field: string;
  readonly operator: "equals" | "not_equals" | "in" | "matches" | "under_budget" | "custom";
  readonly value?: JsonValue;
}

export interface PolicySpec {
  readonly id: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effect: PolicyEffect;
  readonly conditions?: readonly PolicyCondition[];
  readonly approval?: {
    readonly requiredBy?: readonly string[];
    readonly expiresAfter?: string;
  };
}

export interface CapabilityGrant {
  readonly id: string;
  readonly capabilityRef: string;
  readonly subject: string;
  readonly resource: ResourceSelector;
  readonly effect: PolicyEffect;
  readonly budget?: {
    readonly unit: "usd" | "tokens" | "seconds" | "calls" | "bytes";
    readonly limit: number;
  };
  readonly sandboxProfile?: string;
  readonly expiresAfter?: string;
}

export interface RunScopedAuthorityGrant {
  readonly id: string;
  readonly runId: string;
  readonly actorId: string;
  readonly scope: "run" | "trial" | "actor" | "artifact" | "custom";
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effect: PolicyEffect;
  readonly conditions?: readonly PolicyCondition[];
  readonly budget?: CapabilityGrant["budget"];
  readonly sandboxProfile?: string;
  readonly expiresAt?: string;
  readonly approvalState: ApprovalState;
  readonly approvalRef?: string;
  readonly sourceGrantRef?: string;
}

export interface PolicyDecisionRecord {
  readonly id: string;
  readonly runId: string;
  readonly actorId: string;
  readonly policyRef?: string;
  readonly grantRef?: string;
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effect: PolicyEffect;
  readonly decision: "allowed" | "denied" | "approval_required" | "redacted" | "rewritten";
  readonly approvalState?: ApprovalState;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface ArtifactContract {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "patch" | "report" | "trace" | "metric" | "message" | "custom";
  readonly requiredBy?: readonly string[];
  readonly producedBy?: readonly string[];
  readonly reviewedBy?: readonly string[];
  readonly schema?: JsonObject;
}

export interface HarnessDsl {
  readonly kind: "generic-ai.harness";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly packages: readonly PackageUseSpec[];
  readonly capabilities?: readonly CapabilitySpec[];
  readonly agents: readonly AgentSpec[];
  readonly spaces?: readonly SpaceSpec[];
  readonly relationships?: readonly RelationshipSpec[];
  readonly protocols?: readonly ProtocolBindingSpec[];
  readonly policies?: readonly PolicySpec[];
  readonly artifacts?: readonly ArtifactContract[];
  readonly missionRefs?: readonly string[];
  readonly evalRefs?: readonly string[];
  readonly output?: {
    readonly reportRefs?: readonly string[];
    readonly artifactRefs?: readonly string[];
  };
  readonly extensions?: JsonObject;
}

export interface HarnessFingerprint {
  readonly algorithm: "sha256";
  readonly sourceHash: string;
  readonly compiledHash: string;
  readonly schemaVersion: HarnessSchemaVersion;
  readonly compilerVersion: string;
}

export interface CompiledActor {
  readonly id: string;
  readonly role: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly packageRefs: readonly string[];
  readonly capabilityRefs: readonly string[];
  readonly readableSpaces: readonly string[];
  readonly writableSpaces: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly invocationTemplate: string;
}

export interface CompiledHarness {
  readonly kind: "generic-ai.compiled-harness";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly id: string;
  readonly sourceId: string;
  readonly name?: string;
  readonly packages: readonly PackageUseSpec[];
  readonly capabilities: readonly CapabilitySpec[];
  readonly agents: readonly CompiledActor[];
  readonly spaces: readonly SpaceSpec[];
  readonly relationships: readonly RelationshipSpec[];
  readonly protocols: readonly ProtocolBindingSpec[];
  readonly policies: readonly PolicySpec[];
  readonly artifacts: readonly ArtifactContract[];
  readonly missionRefs: readonly string[];
  readonly evalRefs: readonly string[];
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly fingerprint: HarnessFingerprint;
}

export interface CompileHarnessResult {
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly compiled?: CompiledHarness;
}

export interface MissionSpec {
  readonly kind: "generic-ai.mission";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly id: string;
  readonly objective: string;
  readonly objectiveClass: ObjectiveClass;
  readonly fixtureRefs?: readonly string[];
  readonly reset?: {
    readonly workspace?: "clean" | "snapshot" | "preserve";
    readonly storage?: "clean" | "snapshot" | "preserve";
    readonly messages?: "clean" | "preserve";
    readonly memory?: "clean" | "preserve";
  };
  readonly allowedPackages?: readonly string[];
  readonly allowedCapabilities?: readonly string[];
  readonly constraints?: readonly string[];
  readonly budgets?: readonly CapabilityGrant["budget"][];
  readonly expectedArtifacts?: readonly ArtifactContract[];
  readonly graders?: readonly GraderSpec[];
  readonly successCriteria?: {
    readonly requiredSubstrings?: readonly string[];
    readonly requiredArtifacts?: readonly string[];
  };
  readonly providerPolicy?: {
    readonly adapter?: string;
    readonly model?: string;
    readonly cache?: "allow" | "deny";
    readonly network?: "isolated" | "allowlist" | "open";
  };
}

export interface BenchmarkCandidateSpec {
  readonly id: string;
  readonly harnessRef: string;
  readonly label?: string;
}

export interface BenchmarkSpec {
  readonly kind: "generic-ai.benchmark";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly id: string;
  readonly missionRef: string;
  readonly hypothesis: string;
  readonly candidates: readonly BenchmarkCandidateSpec[];
  readonly primaryMetric: string;
  readonly guardrailMetrics?: readonly string[];
  readonly trials: {
    readonly count: number;
    readonly pairing: "paired" | "independent";
    readonly seed?: string;
  };
  readonly validity?: {
    readonly minimumTrialsForRecommendation?: number;
    readonly requireTraceCompleteness?: boolean;
    readonly allowSingleRunRecommendation?: boolean;
  };
  readonly report?: {
    readonly formats: readonly ("json" | "markdown")[];
    readonly includeRecommendations?: boolean;
  };
}

export interface MetricDefinition {
  readonly id: string;
  readonly name: string;
  readonly unit: "boolean" | "count" | "ratio" | "usd" | "seconds" | "milliseconds" | "custom";
  readonly direction: "higher_is_better" | "lower_is_better" | "informational";
  readonly source: "trace" | "artifact" | "grader" | "runtime" | "report";
  readonly description?: string;
}

export interface MetricValue {
  readonly metricId: string;
  readonly value: number;
  readonly evidenceRefs: readonly string[];
}

export interface GraderSpec {
  readonly id: string;
  readonly metricRefs: readonly string[];
  readonly packageRef?: string;
  readonly deterministic: boolean;
  readonly config?: JsonObject;
}

export interface ArtifactReference {
  readonly id: string;
  readonly kind: ArtifactContract["kind"];
  readonly uri: string;
  readonly sha256?: string;
  readonly redaction: "none" | "metadata_only" | "redacted";
  readonly summary?: string;
}

export type TraceEventType =
  | "harness.compiled"
  | "benchmark.started"
  | "trial.started"
  | "actor.invoked"
  | "actor.completed"
  | "protocol.action.planned"
  | "tool.invoked"
  | "artifact.created"
  | "policy.decision"
  | "grader.completed"
  | "trial.completed"
  | "benchmark.completed"
  | "diagnostic";

export interface TraceEvent {
  readonly id: string;
  readonly type: TraceEventType;
  readonly sequence: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly harnessId?: string;
  readonly candidateId?: string;
  readonly trialId?: string;
  readonly actorId?: string;
  readonly packageId?: string;
  readonly protocolId?: string;
  readonly artifactId?: string;
  readonly parentEventId?: string;
  readonly causedByEventId?: string;
  readonly policyDecisionId?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly payloadRef?: ArtifactReference;
  readonly summary: string;
}

export interface TraceDiagnostics {
  readonly completeness: number;
  readonly missingRequiredEventTypes: readonly TraceEventType[];
  readonly handoffCount: number;
  readonly reworkCount: number;
  readonly policyDecisionCount: number;
  readonly artifactCount: number;
}

export interface ProtocolState {
  readonly status: ProtocolTerminalState;
  readonly data?: JsonObject;
}

export interface ProtocolAction {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind:
    | "invoke_actor"
    | "claim_work"
    | "delegate_work"
    | "review_artifact"
    | "request_approval"
    | "emit_trace"
    | "complete"
    | "fail"
    | "custom";
  readonly actorRef?: string;
  readonly artifactRef?: string;
  readonly payload?: JsonObject;
}

export interface ProtocolSummary {
  readonly status: ProtocolTerminalState;
  readonly actionCount: number;
  readonly blockerCount: number;
  readonly notes?: readonly string[];
}

export interface ProtocolPlugin {
  readonly manifest: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly protocol: string;
  };
  readonly initialize?: (compiled: CompiledHarness) => Awaitable<ProtocolState>;
  readonly validate?: (compiled: CompiledHarness) => Awaitable<readonly CompileDiagnostic[]>;
  readonly reduce: (input: {
    readonly compiled: CompiledHarness;
    readonly state: ProtocolState;
    readonly events: readonly TraceEvent[];
  }) => Awaitable<{
    readonly state: ProtocolState;
    readonly actions: readonly ProtocolAction[];
    readonly summary: ProtocolSummary;
  }>;
}

export interface BenchmarkTrialResult {
  readonly candidateId: string;
  readonly harnessId: string;
  readonly trialId: string;
  readonly metrics: readonly MetricValue[];
  readonly traceEvents: readonly TraceEvent[];
  readonly artifacts: readonly ArtifactReference[];
  readonly diagnostics: TraceDiagnostics;
}

export interface BenchmarkReportCandidate {
  readonly candidateId: string;
  readonly harnessId: string;
  readonly trialCount: number;
  readonly scorecard: readonly MetricValue[];
  readonly traceCompleteness: number;
  readonly recommendation: RecommendationBoundary;
  readonly rationale: readonly string[];
}

export interface BenchmarkReport {
  readonly kind: "generic-ai.benchmark-report";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly benchmarkId: string;
  readonly missionId: string;
  readonly generatedAt: string;
  readonly hypothesis: string;
  readonly primaryMetric: string;
  readonly observations: readonly string[];
  readonly inferences: readonly string[];
  readonly recommendations: readonly string[];
  readonly candidates: readonly BenchmarkReportCandidate[];
  readonly evidence: {
    readonly traceEventCount: number;
    readonly artifactCount: number;
    readonly metricCount: number;
  };
  readonly insufficientEvidence: readonly string[];
}

export interface HarnessPatchOperation {
  readonly op: "add" | "remove" | "replace";
  readonly path: string;
  readonly value?: JsonValue;
  readonly reason: string;
}

export interface HarnessPatch {
  readonly kind: "generic-ai.harness-patch";
  readonly schemaVersion: HarnessSchemaVersion;
  readonly id: string;
  readonly targetHarnessRef: string;
  readonly baseFingerprint: string;
  readonly lifecycle:
    | "proposed"
    | "schema_validated"
    | "policy_checked"
    | "compiled"
    | "dry_run_validated"
    | "benchmarked_against_baseline"
    | "reviewed"
    | "approved"
    | "staged"
    | "applied"
    | "monitored"
    | "kept_or_rolled_back";
  readonly operations: readonly HarnessPatchOperation[];
  readonly riskFlags?: readonly string[];
  readonly approvalRequired?: boolean;
  readonly validationPlan?: readonly string[];
  readonly expectedImprovement?: readonly string[];
}
