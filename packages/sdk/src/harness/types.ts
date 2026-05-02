import type { Awaitable, JsonObject, JsonValue } from "../contracts/shared.js";
import type { CanonicalEvent } from "../events/index.js";
import type { RunEnvelope } from "../run-envelope/index.js";
import type {
  AgentLifecycleHookDecisionRecord,
  AgentLifecycleHooksConfig,
} from "../contracts/agent-lifecycle.js";

export const HARNESS_SCHEMA_VERSION = "0.1" as const;

export type HarnessSchemaVersion = typeof HARNESS_SCHEMA_VERSION;
export const AGENT_HARNESS_ADAPTER_KINDS = ["pi", "external"] as const;
export const AGENT_HARNESS_ROLE_KINDS = [
  "root",
  "planner",
  "explorer",
  "builder",
  "verifier",
  "custom",
] as const;
export const AGENT_HARNESS_POLICY_PROFILES = ["local-dev-full", "benchmark-container"] as const;
export const AGENT_TURN_MODES = ["stop-tool-loop", "single-turn"] as const;
export const AGENT_HARNESS_CAPABILITY_EFFECTS = [
  "fs.read",
  "fs.write",
  "process.spawn",
  "network.egress",
  "mcp.read",
  "mcp.launch",
  "memory.read",
  "memory.write",
  "handoff.read",
  "handoff.write",
  "artifact.write",
  "repo.inspect",
  "lsp.read",
  "secret.read",
  "sandbox.create",
] as const;

export const AGENT_HARNESS_EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "session.started",
  "session.completed",
  "session.failed",
  "session.compaction.started",
  "session.compaction.completed",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "terminal.command.started",
  "terminal.command.completed",
  "terminal.command.failed",
  "policy.decision",
  "hook.execution.started",
  "hook.execution.completed",
  "hook.execution.failed",
  "hook.decision",
  "artifact.created",
  "handoff.requested",
  "handoff.accepted",
  "handoff.completed",
  "handoff.failed",
  "model.message",
] as const;

export type AgentHarnessAdapterKind = (typeof AGENT_HARNESS_ADAPTER_KINDS)[number];
export type AgentHarnessController = "model-directed";
export type AgentHarnessRoleKind = (typeof AGENT_HARNESS_ROLE_KINDS)[number];
export type AgentHarnessPolicyProfileId = (typeof AGENT_HARNESS_POLICY_PROFILES)[number];
export type AgentTurnMode = (typeof AGENT_TURN_MODES)[number];
export type AgentHarnessCapabilityEffect =
  | (typeof AGENT_HARNESS_CAPABILITY_EFFECTS)[number]
  | `custom.${string}`;
export type AgentHarnessEventType = (typeof AGENT_HARNESS_EVENT_TYPES)[number];
export type DiagnosticSeverity = "error" | "warning";
export type ObjectiveClass = "coding" | "research" | "operations" | "analysis" | "custom";
export type PolicyEffect = "allow" | "deny" | "require_approval" | "redact" | "rewrite";
export type ApprovalState = "not_required" | "pending" | "approved" | "rejected" | "expired";
export type ProtocolTerminalState = "blocked" | "idle" | "ready" | "done" | "failed";
export type RecommendationBoundary = "recommended" | "not_recommended" | "insufficient_evidence";
export type BenchmarkTrialOutcomeStatus = "passed" | "failed" | "skipped" | "excluded";
export type BenchmarkFailureSeverity = "none" | "low" | "medium" | "high" | "critical";
export type BenchmarkConfidenceLevel =
  | "confident_recommendation"
  | "bounded_recommendation"
  | "insufficient_evidence";
export type AgentHarnessReversibility =
  | "irreversible"
  | "reversible-with-cost"
  | "reversible-cheap";
export type AgentHarnessRetrySemantics =
  | "safe-to-retry"
  | "idempotency-key-required"
  | "retry-may-duplicate";
export type FaultInjectionBoundary =
  | "tool"
  | "retrieval"
  | "memory"
  | "web"
  | "mcp"
  | "messaging"
  | "storage"
  | "custom";
export type FaultInjectionPerturbation =
  | "timeout"
  | "partial_response"
  | "bad_payload"
  | "stale_context"
  | "schema_drift"
  | "service_fault"
  | "permission_denied"
  | "custom";
export type FaultInjectionExpectedBehavior =
  | "retry"
  | "fallback"
  | "degrade_gracefully"
  | "ask_for_clarification"
  | "block_action"
  | "mark_insufficient_evidence";
export type FaultInjectionSeverity = "low" | "medium" | "high" | "critical";
export type FaultInjectionTiming =
  | "before_call"
  | "during_call"
  | "after_call"
  | "state_read"
  | "state_write";
export type BenchmarkToolUseExpectation = "required" | "optional" | "wasteful";
export type MaintainabilityCheckKind =
  | "typecheck"
  | "lint"
  | "test"
  | "build"
  | "docs"
  | "api"
  | "custom";
export type ContextualIntegrityTransmissionExpectation =
  | "required"
  | "permitted"
  | "prohibited";
export type ContextualIntegrityDataSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "secret"
  | "custom";

export interface AgentHarnessRole {
  readonly id: string;
  readonly kind: AgentHarnessRoleKind;
  readonly description?: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly readOnly?: boolean;
  readonly metadata?: JsonObject;
}

export interface AgentExecutionConfig {
  readonly turnMode?: AgentTurnMode;
  /** Optional finite stop-tool loop cap. Omit for unbounded execution. */
  readonly maxTurns?: number;
}

export interface AgentHarnessPolicyProfile {
  readonly id: AgentHarnessPolicyProfileId;
  readonly description: string;
  readonly sharedWorkspace: boolean;
  readonly defaultNetwork: "allow" | "deny";
  readonly defaultMcp: "allow" | "deny";
  readonly nestedSandbox: "allow" | "deny";
  readonly immutablePathPatterns?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface AgentHarnessConfig {
  readonly id: string;
  readonly displayName?: string;
  readonly adapter?: AgentHarnessAdapterKind;
  readonly controller?: AgentHarnessController;
  readonly model?: string;
  readonly primaryAgent?: string;
  readonly policyProfile?: AgentHarnessPolicyProfileId;
  readonly roles?: readonly AgentHarnessRole[];
  readonly execution?: AgentExecutionConfig;
  readonly tools?: readonly string[];
  readonly allowNetwork?: boolean;
  readonly allowMcp?: boolean;
  readonly artifactDir?: string;
  readonly hooks?: AgentLifecycleHooksConfig;
  readonly metadata?: JsonObject;
}

export interface AgentHarnessBudget {
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly maxToolCalls?: number;
  readonly maxWallTimeMs?: number;
}

export interface AgentHarnessRunInput<TCapabilities = unknown> {
  readonly instruction: string;
  readonly harness: AgentHarnessConfig;
  readonly workspaceRoot: string;
  readonly runId?: string;
  readonly rootScopeId?: string;
  readonly rootAgentId?: string;
  readonly artifactDir?: string;
  readonly hooks?: AgentLifecycleHooksConfig;
  readonly deadline?: string;
  readonly budget?: AgentHarnessBudget;
  readonly capabilities?: TCapabilities;
  readonly metadata?: JsonObject;
}

export interface AgentHarnessToolDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  readonly reversibility?: AgentHarnessReversibility;
  readonly retrySemantics?: AgentHarnessRetrySemantics;
  readonly metadata?: JsonObject;
}

export interface AgentHarnessEffectMetadata {
  readonly genericAi?: {
    readonly descriptor?: AgentHarnessToolDescriptor;
    readonly effects?: readonly AgentHarnessCapabilityEffect[];
    readonly reversibility?: AgentHarnessReversibility;
    readonly retrySemantics?: AgentHarnessRetrySemantics;
  };
}

export function getAgentHarnessToolEffects(
  tool: AgentHarnessEffectMetadata | unknown,
): readonly AgentHarnessCapabilityEffect[] {
  if (typeof tool !== "object" || tool === null || !("genericAi" in tool)) {
    return [];
  }

  const metadata = (tool as AgentHarnessEffectMetadata).genericAi;
  return metadata?.effects ?? metadata?.descriptor?.effects ?? [];
}

export function getAgentHarnessToolReversibility(
  tool: AgentHarnessEffectMetadata | unknown,
): AgentHarnessReversibility | undefined {
  if (typeof tool !== "object" || tool === null || !("genericAi" in tool)) {
    return undefined;
  }

  const metadata = (tool as AgentHarnessEffectMetadata).genericAi;
  return metadata?.reversibility ?? metadata?.descriptor?.reversibility;
}

export function withAgentHarnessToolEffects<TTool extends object>(
  tool: TTool,
  descriptorOrEffects: AgentHarnessToolDescriptor | readonly AgentHarnessCapabilityEffect[],
): TTool & AgentHarnessEffectMetadata {
  const isDescriptor = !Array.isArray(descriptorOrEffects);
  const descriptor = isDescriptor ? (descriptorOrEffects as AgentHarnessToolDescriptor) : undefined;
  const effects = isDescriptor
    ? (descriptorOrEffects as AgentHarnessToolDescriptor).effects
    : descriptorOrEffects;
  const reversibility = descriptor?.reversibility ?? "irreversible";
  const retrySemantics = descriptor?.retrySemantics;
  const value = Object.freeze({
    ...(descriptor === undefined ? {} : { descriptor }),
    effects: Object.freeze([...effects]),
    reversibility,
    ...(retrySemantics === undefined ? {} : { retrySemantics }),
  });

  try {
    Object.defineProperty(tool, "genericAi", {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return tool as TTool & AgentHarnessEffectMetadata;
  } catch {
    const clone = Object.create(Object.getPrototypeOf(tool)) as TTool;
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(tool));
    Object.defineProperty(clone, "genericAi", {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return clone as TTool & AgentHarnessEffectMetadata;
  }
}

export type AgentHarnessArtifactKind =
  | "trace"
  | "report"
  | "handoff"
  | "policy"
  | "hook"
  | "events"
  | "summary"
  | "custom";

export interface AgentHarnessArtifactRef {
  readonly id: string;
  readonly kind: AgentHarnessArtifactKind;
  readonly uri: string;
  readonly sha256?: string;
  readonly localPath?: string;
  readonly ownerId?: string;
  readonly namespace?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
}

export interface AgentHarnessEventProjection {
  readonly id: string;
  readonly sequence: number;
  readonly type: AgentHarnessEventType;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly roleId?: string;
  readonly toolName?: string;
  readonly reversibility?: AgentHarnessReversibility;
  readonly supersedesEventId?: string;
  readonly summary: string;
  readonly data: JsonObject;
}

export interface AgentHarnessRunResult<TOutput = string> {
  readonly harnessId: string;
  readonly adapter: AgentHarnessAdapterKind;
  readonly status: "succeeded" | "failed";
  readonly outputText: string;
  readonly output?: TOutput;
  readonly envelope: RunEnvelope<TOutput>;
  readonly events: readonly CanonicalEvent[];
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly artifacts: readonly AgentHarnessArtifactRef[];
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly hookDecisions: readonly AgentLifecycleHookDecisionRecord[];
  readonly failureMessage?: string;
  readonly errorCategory?: AgentHarnessRunErrorCategory;
  readonly metadata?: JsonObject;
}

export type AgentHarnessRunErrorCategory =
  | "cancelled"
  | "deadline_exceeded"
  | "budget_exceeded"
  | "policy_denied"
  | "adapter_error"
  | "model_error"
  | "tool_error"
  | "unknown";

export interface AgentHarnessPolicyEvaluationInput {
  readonly runId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  readonly evidenceRefs?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface AgentHarnessPolicyEvaluation {
  readonly decision: PolicyDecisionRecord;
  readonly allowed: boolean;
}

export interface AgentHarnessEventSink {
  emit(event: AgentHarnessEventProjection): Awaitable<void>;
}

export interface AgentHarnessArtifactWriteInput {
  readonly id: string;
  readonly kind: AgentHarnessArtifactKind;
  readonly bytes: string | Uint8Array;
  readonly contentType?: string;
  readonly description?: string;
  readonly ownerId?: string;
  readonly namespace?: string;
  readonly metadata?: JsonObject;
}

export interface AgentHarnessArtifactStore {
  write(input: AgentHarnessArtifactWriteInput): Awaitable<AgentHarnessArtifactRef>;
}

export interface AgentHarnessPolicyEvaluator {
  evaluate(input: AgentHarnessPolicyEvaluationInput): Awaitable<AgentHarnessPolicyEvaluation>;
}

export interface AgentHarnessAdapterRunContext {
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
  readonly budget?: AgentHarnessBudget;
  readonly events: AgentHarnessEventSink;
  readonly artifacts: AgentHarnessArtifactStore;
  readonly policy: AgentHarnessPolicyEvaluator;
}

export interface AgentHarnessAdapter<TCapabilities = unknown, TOutput = string> {
  readonly id: string;
  readonly kind: AgentHarnessAdapterKind;
  run(
    input: AgentHarnessRunInput<TCapabilities>,
    context: AgentHarnessAdapterRunContext,
  ): Awaitable<AgentHarnessRunResult<TOutput>>;
}

export interface AgentHarness<TCapabilities = unknown, TOutput = string> {
  readonly config: AgentHarnessConfig;
  readonly adapter: AgentHarnessAdapter<TCapabilities, TOutput>;
  run(
    input: Omit<AgentHarnessRunInput<TCapabilities>, "harness">,
  ): Awaitable<AgentHarnessRunResult<TOutput>>;
}

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
  readonly kind:
    | "workspace"
    | "message-thread"
    | "memory"
    | "artifact-store"
    | "scratch"
    | "custom";
  readonly description?: string;
  readonly visibility?: "private" | "shared" | "public";
  readonly ownerAgentRef?: string;
}

export interface RelationshipSpec {
  readonly id: string;
  readonly kind:
    | "delegates_to"
    | "reviews"
    | "coordinates_with"
    | "reports_to"
    | "blocks"
    | "custom";
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
  readonly reversibility?: AgentHarnessReversibility;
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
  readonly reversibility?: AgentHarnessReversibility;
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
  readonly reversibility?: AgentHarnessReversibility;
  readonly decision: "allowed" | "denied" | "approval_required" | "redacted" | "rewritten";
  readonly approvalState?: ApprovalState;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly supersedesDecisionId?: string;
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
  readonly metricDefinitions?: readonly MetricDefinition[];
  readonly guardrailMetrics?: readonly string[];
  readonly faultInjections?: readonly FaultInjectionSpec[];
  readonly toolUse?: BenchmarkToolUseProfile;
  readonly maintainability?: MaintainabilityProfile;
  readonly contextualIntegrity?: ContextualIntegrityProfile;
  readonly trials?: {
    /** Defaults to 1 until v1.0 flips repeated trials from recommended to required. */
    readonly count?: number;
    readonly pairing: "paired" | "independent";
    readonly seed?: string;
    readonly replayId?: string;
    /** Optional per-trial-block minimum; top-level minTrials takes precedence. */
    readonly minTrials?: number;
    readonly smoke?: boolean;
    /** pass^k horizon. Defaults to the configured trial count. */
    readonly passK?: number;
  };
  readonly reliability?: BenchmarkReliabilityProfile;
  /** Minimum observed trials required before recommendations can be confident. */
  readonly minTrials?: number;
  /** Marks a benchmark as a wiring/smoke check instead of a claim-bearing comparison. */
  readonly smoke?: boolean;
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

export interface BenchmarkReliabilityProfile {
  readonly id?: string;
  readonly successMetric?: string;
  readonly successThreshold?: number;
  readonly minimumScoredTrials?: number;
  readonly passAt?: readonly number[];
  readonly failureSeverityMetric?: string;
  readonly perturbationLabels?: readonly string[];
}

export interface BenchmarkToolUseProfile {
  readonly id?: string;
  readonly maxToolCalls?: number;
  readonly cases: readonly BenchmarkToolUseCaseSpec[];
}

export interface BenchmarkToolUseCaseSpec {
  readonly id: string;
  readonly taskRef: string;
  readonly expectation: BenchmarkToolUseExpectation;
  readonly maxToolCalls?: number;
  readonly expectedToolCalls?: number;
  readonly directAnswerEligible?: boolean;
  readonly targetTools?: readonly string[];
  readonly rationale?: string;
  readonly metadata?: JsonObject;
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

export interface FaultInjectionSpec {
  readonly id: string;
  readonly boundary: FaultInjectionBoundary;
  readonly perturbation: FaultInjectionPerturbation;
  readonly targetRef: string;
  readonly expectedBehavior: FaultInjectionExpectedBehavior;
  readonly severity?: FaultInjectionSeverity;
  readonly injectedAt?: FaultInjectionTiming;
  readonly firstViolatedContract?: string;
  readonly metadata?: JsonObject;
}

export interface FaultInjectionObservation {
  readonly specRef: string;
  readonly boundary: FaultInjectionBoundary;
  readonly perturbation: FaultInjectionPerturbation;
  readonly contained: boolean;
  readonly recovered: boolean;
  readonly overclaimPrevented: boolean;
  readonly firstViolatedContract?: string;
  readonly recoveryPath?: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly notes?: readonly string[];
}

export interface FaultInjectionReportSummary {
  readonly plannedCaseCount: number;
  readonly observedCaseCount: number;
  readonly containedCaseCount: number;
  readonly recoveredCaseCount: number;
  readonly overclaimPreventedCount: number;
  readonly containmentRate: number;
  readonly recoveryRate: number;
  readonly overclaimPreventionRate: number;
  readonly firstViolatedContracts: readonly string[];
}

export interface ToolUseObservation {
  readonly caseRef: string;
  readonly expectation?: BenchmarkToolUseExpectation;
  readonly toolCalls: number;
  readonly necessaryToolCalls?: number;
  readonly unnecessaryToolCalls?: number;
  readonly avoidedToolCalls?: number;
  readonly budgetLimit?: number;
  readonly budgetViolated?: boolean;
  readonly directAnswerEligible?: boolean;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly evidenceRefs: readonly string[];
  readonly notes?: readonly string[];
}

export interface ToolUseExpectationSummary {
  readonly expectation: BenchmarkToolUseExpectation;
  readonly plannedCaseCount: number;
  readonly observedCaseCount: number;
  readonly toolCalls: number;
  readonly unnecessaryToolCalls: number;
  readonly avoidedToolCalls: number;
  readonly budgetViolations: number;
}

export interface ToolUseReportSummary {
  readonly profileId?: string;
  readonly plannedCaseCount: number;
  readonly observedCaseCount: number;
  readonly totalToolCalls: number;
  readonly necessaryToolCalls: number;
  readonly unnecessaryToolCalls: number;
  readonly avoidedToolCalls: number;
  readonly budgetViolations: number;
  readonly directAnswerOpportunities: number;
  readonly efficiencyScore: number | null;
  readonly totalCostUsd?: number;
  readonly totalLatencyMs?: number;
  readonly byExpectation: readonly ToolUseExpectationSummary[];
  readonly evidenceRefs: readonly string[];
  readonly warnings: readonly string[];
}

export interface MaintainabilityStepSpec {
  readonly id: string;
  readonly taskRef: string;
  readonly description?: string;
  readonly resetRef?: string;
  readonly expectedChecks?: readonly MaintainabilityCheckKind[];
  readonly metadata?: JsonObject;
}

export interface MaintainabilityProfile {
  readonly id?: string;
  readonly steps: readonly MaintainabilityStepSpec[];
}

export interface MaintainabilityObservation {
  readonly stepRef: string;
  readonly immediateTaskSatisfied: boolean;
  readonly checksRun: readonly MaintainabilityCheckKind[];
  readonly checksPassed: readonly MaintainabilityCheckKind[];
  readonly newRegressionCount?: number;
  readonly publicApiDriftCount?: number;
  readonly docsDriftCount?: number;
  readonly lintDebtCount?: number;
  readonly typeDebtCount?: number;
  readonly rollbackRequired?: boolean;
  readonly recoverySucceeded?: boolean;
  readonly evidenceRefs: readonly string[];
  readonly notes?: readonly string[];
}

export interface MaintainabilityStepSummary {
  readonly stepRef: string;
  readonly immediateTaskSatisfied: boolean;
  readonly checkPassRate: number | null;
  readonly regressionCount: number;
  readonly publicApiDriftCount: number;
  readonly docsDriftCount: number;
  readonly lintDebtCount: number;
  readonly typeDebtCount: number;
  readonly rollbackRequired: boolean;
  readonly recoverySucceeded: boolean;
}

export interface MaintainabilityReportSummary {
  readonly profileId?: string;
  readonly plannedStepCount: number;
  readonly observedStepCount: number;
  readonly immediateSuccessCount: number;
  readonly immediateSuccessRate: number;
  readonly averageCheckPassRate: number | null;
  readonly regressionCount: number;
  readonly regressionRate: number;
  readonly publicApiDriftCount: number;
  readonly docsDriftCount: number;
  readonly lintDebtCount: number;
  readonly typeDebtCount: number;
  readonly rollbackRequiredCount: number;
  readonly recoverySucceededCount: number;
  readonly maintainabilityScore: number | null;
  readonly byStep: readonly MaintainabilityStepSummary[];
  readonly evidenceRefs: readonly string[];
  readonly warnings: readonly string[];
}

export interface ContextualIntegrityActorSpec {
  readonly id: string;
  readonly role: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
}

export interface ContextualIntegrityDataClassSpec {
  readonly id: string;
  readonly label?: string;
  readonly sensitivity: ContextualIntegrityDataSensitivity;
  readonly description?: string;
  readonly examples?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ContextualIntegrityTransmissionPrincipleSpec {
  readonly id: string;
  readonly senderRef: string;
  readonly recipientRef: string;
  readonly purpose: string;
  readonly dataClassRefs: readonly string[];
  readonly expectation: ContextualIntegrityTransmissionExpectation;
  readonly requiresApproval?: boolean;
  readonly rationale?: string;
  readonly metadata?: JsonObject;
}

export interface ContextualIntegrityCaseSpec {
  readonly id: string;
  readonly taskRef: string;
  readonly senderRef: string;
  readonly recipientRef: string;
  readonly purpose: string;
  readonly requiredDataClassRefs?: readonly string[];
  readonly allowedDataClassRefs?: readonly string[];
  readonly forbiddenDataClassRefs?: readonly string[];
  readonly approvalDataClassRefs?: readonly string[];
  readonly rationale?: string;
  readonly metadata?: JsonObject;
}

export interface ContextualIntegrityProfile {
  readonly id?: string;
  readonly actors: readonly ContextualIntegrityActorSpec[];
  readonly dataClasses: readonly ContextualIntegrityDataClassSpec[];
  readonly transmissionPrinciples: readonly ContextualIntegrityTransmissionPrincipleSpec[];
  readonly cases: readonly ContextualIntegrityCaseSpec[];
}

export interface ContextualIntegrityObservation {
  readonly caseRef: string;
  readonly senderRef?: string;
  readonly recipientRef?: string;
  readonly purpose?: string;
  readonly disclosedDataClassRefs: readonly string[];
  readonly withheldDataClassRefs?: readonly string[];
  readonly approvalDataClassRefs?: readonly string[];
  readonly requiredDisclosureRefs?: readonly string[];
  readonly prohibitedDisclosureRefs?: readonly string[];
  readonly utilitySatisfied: boolean;
  readonly evidenceRefs: readonly string[];
  readonly notes?: readonly string[];
}

export interface ContextualIntegrityCaseSummary {
  readonly caseRef: string;
  readonly disclosedDataClassCount: number;
  readonly requiredDisclosureMisses: number;
  readonly prohibitedDisclosureViolations: number;
  readonly utilitySatisfied: boolean;
}

export interface ContextualIntegrityReportSummary {
  readonly profileId?: string;
  readonly plannedCaseCount: number;
  readonly observedCaseCount: number;
  readonly utilitySatisfiedCount: number;
  readonly utilityRate: number;
  readonly requiredDisclosureCount: number;
  readonly requiredDisclosureMissCount: number;
  readonly prohibitedDisclosureCount: number;
  readonly prohibitedDisclosureViolationCount: number;
  readonly allowedDisclosureCount: number;
  readonly leakageRate: number;
  readonly contextualIntegrityScore: number | null;
  readonly byCase: readonly ContextualIntegrityCaseSummary[];
  readonly evidenceRefs: readonly string[];
  readonly warnings: readonly string[];
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
  readonly seed?: string;
  readonly replayId?: string;
  readonly reversibility?: AgentHarnessReversibility;
  readonly supersedesEventId?: string;
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
  readonly outcome?: BenchmarkTrialOutcome;
  readonly seed?: string;
  readonly replayId?: string;
  readonly metrics: readonly MetricValue[];
  readonly traceEvents: readonly TraceEvent[];
  readonly artifacts: readonly ArtifactReference[];
  readonly diagnostics: TraceDiagnostics;
  readonly faultInjections?: readonly FaultInjectionObservation[];
  readonly toolUse?: readonly ToolUseObservation[];
  readonly maintainability?: readonly MaintainabilityObservation[];
  readonly contextualIntegrity?: readonly ContextualIntegrityObservation[];
}

export interface BenchmarkTrialOutcome {
  readonly status: BenchmarkTrialOutcomeStatus;
  readonly attempt?: number;
  readonly retryOfTrialId?: string;
  readonly perturbationLabel?: string;
  readonly failureSeverity?: BenchmarkFailureSeverity;
  readonly exclusionReason?: string;
}

export interface BenchmarkReliabilityPerturbationSummary {
  readonly label: string;
  readonly trialCount: number;
  readonly passRate: number | null;
}

export interface BenchmarkReliabilitySummary {
  readonly profileId?: string;
  readonly totalTrials: number;
  readonly scoredTrials: number;
  readonly passedTrials: number;
  readonly failedTrials: number;
  readonly skippedTrials: number;
  readonly excludedTrials: number;
  readonly retriedTrials: number;
  readonly passRate: number | null;
  readonly consistency: number | null;
  readonly variance: number | null;
  readonly passAt: readonly MetricValue[];
  readonly maxFailureSeverity: BenchmarkFailureSeverity;
  readonly averageFailureSeverity: number;
  readonly perturbations: readonly BenchmarkReliabilityPerturbationSummary[];
  readonly warnings: readonly string[];
}

export interface BenchmarkPassKSummary {
  readonly metricId: string;
  readonly k: number;
  readonly passCount: number;
  readonly sampleCount: number;
  readonly trialCount: number;
  readonly observedPassRate: number;
  readonly value: number;
  readonly evidenceRefs: readonly string[];
}

export interface BenchmarkReportConfidence {
  readonly level: BenchmarkConfidenceLevel;
  readonly minTrials: number;
  readonly observedTrials: number;
  readonly configuredTrials: number;
  readonly smoke: boolean;
  readonly reasons: readonly string[];
}

export interface BenchmarkReversibilitySummary {
  readonly totalEventCount: number;
  readonly irreversibleCount: number;
  readonly reversibleWithCostCount: number;
  readonly reversibleCheapCount: number;
  readonly supersededEventCount: number;
  readonly evidenceRefs: readonly string[];
}

export interface BenchmarkReportCandidate {
  readonly candidateId: string;
  readonly harnessId: string;
  readonly trialCount: number;
  readonly scorecard: readonly MetricValue[];
  readonly passK?: BenchmarkPassKSummary;
  readonly traceCompleteness: number;
  readonly recommendation: RecommendationBoundary;
  readonly reliability?: BenchmarkReliabilitySummary;
  readonly confidence: BenchmarkReportConfidence;
  readonly reversibility?: BenchmarkReversibilitySummary;
  readonly rationale: readonly string[];
  readonly faultInjection?: FaultInjectionReportSummary;
  readonly toolUse?: ToolUseReportSummary;
  readonly maintainability?: MaintainabilityReportSummary;
  readonly contextualIntegrity?: ContextualIntegrityReportSummary;
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
  readonly confidence: BenchmarkReportConfidence;
  readonly reversibility?: BenchmarkReversibilitySummary;
  readonly evidence: {
    readonly traceEventCount: number;
    readonly artifactCount: number;
    readonly metricCount: number;
  };
  readonly insufficientEvidence: readonly string[];
  readonly faultInjection?: FaultInjectionReportSummary;
  readonly toolUse?: ToolUseReportSummary;
  readonly maintainability?: MaintainabilityReportSummary;
  readonly contextualIntegrity?: ContextualIntegrityReportSummary;
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
