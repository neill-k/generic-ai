import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type AgentHarness,
  type AgentHarnessAdapter,
  type AgentHarnessAdapterKind,
  type AgentHarnessAdapterRunContext,
  type AgentHarnessArtifactRef,
  type AgentHarnessArtifactStore,
  type AgentHarnessArtifactWriteInput,
  type AgentHarnessCapabilityEffect,
  type AgentHarnessBudget,
  type AgentHarnessConfig,
  type AgentHarnessEventSink,
  type AgentHarnessEventProjection,
  type AgentHarnessEventType,
  type AgentLifecycleHookContext,
  type AgentLifecycleHookDecisionRecord,
  type AgentLifecycleInProcessHookHandler,
  type AgentHarnessPolicyEvaluationInput,
  type AgentHarnessPolicyEvaluator,
  type AgentHarnessPolicyProfileId,
  type AgentHarnessRole,
  type AgentHarnessRunInput,
  type AgentHarnessRunErrorCategory,
  type AgentHarnessRunResult,
  type CanonicalEvent,
  getAgentHarnessToolEffects,
  goalTraceFromCanonicalEvents,
  type JsonObject,
  type PolicyDecisionRecord,
  type ResourceSelector,
  type RunActor,
  type RunEnvelope,
  type UsageBudgetLimits,
  type UsageSummary,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import {
  AuthStorage,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@generic-ai/sdk/pi";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { StreamFn } from "@generic-ai/agent";
import { type Model, type RetryPolicy, resolveApiKey, type ThinkingLevel } from "@generic-ai/ai";
import {
  type CompactionSettings,
  SessionManager as NativeSessionManager,
} from "@generic-ai/session";
import { Type } from "@sinclair/typebox";

import { createCanonicalEventStream, type CanonicalEventStream } from "../events/index.js";
import {
  type CapabilityPiSessionEventContext,
  expandMcpCapabilityTools,
  type PiCapabilityBindings,
  type PiCapabilitySessionLifecycleHooks,
  runCapabilityPiAgentSession,
} from "../runtime/capability-runtime.js";
import type { PiRuntimeFactories } from "../runtime/pi.js";
import { DEFAULT_NATIVE_MODEL, resolveNativeModel } from "../runtime/native.js";
import { runCapabilityNativeAgentSession } from "../runtime/native-session.js";
import { createUsageMeter, type UsageMeter } from "../usage/index.js";
import { DEFAULT_OPENAI_CODEX_MODEL } from "../runtime/types.js";
import {
  secretAccessPolicyDecision,
  secretsPromptGuidance,
  wrapCapabilitiesWithSecrets,
} from "./secrets.js";
import {
  type HarnessTopologyRunResult,
  resolveTopologyActorRole,
  type RunHarnessTopologyOptions,
  runHarnessTopology,
  type TopologyActorInvocation,
  type TopologyActorResult,
  type TopologyActorRunner,
} from "./topology-runner.js";
import {
  appendHookContext,
  createAgentLifecycleHookExecutor,
  type AgentLifecycleHookExecutor,
  wrapToolWithLifecycleHooks,
} from "./lifecycle-hooks.js";

type AgentHarnessAdapterRegistry<TCapabilities, TOutput> = Readonly<
  Partial<Record<AgentHarnessAdapterKind, AgentHarnessAdapter<TCapabilities, TOutput>>>
>;

/** Options for the native runtime adapter (`adapter: "native"`). */
export interface NativeAgentHarnessOptions {
  /**
   * Resolve a model reference (`provider/model-id`, or a bare id) to a model. Defaults to the
   * native catalog. Role models (`role.model`) and the harness model (`harness.model`) both go
   * through it, so each role can run on its own provider and model.
   */
  readonly resolveModel?: (ref: string) => Model;
  /** API key for every provider. Defaults to the provider's own environment variable, then `GENERIC_AI_PROVIDER_API_KEY`. */
  readonly apiKey?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** Replace the provider stream (tests, recording, proxies). */
  readonly streamFn?: StreamFn;
  /** Base system prompt for every session. Tool guidance, skills, and the working directory are appended. */
  readonly systemPrompt?: string;
  /**
   * Directory for session files. When set, every role session is recorded as a JSONL file there
   * (one per session, named by session id) so it can be inspected or resumed. Default: in memory.
   */
  readonly sessionDir?: string;
  /** Auto-compaction settings for every session; `false` turns compaction off. */
  readonly compaction?: Partial<CompactionSettings> | false;
  /** Retry policy for transient provider errors; `false` turns retry off. */
  readonly retry?: RetryPolicy | false;
}

export interface CreateAgentHarnessOptions<
  TCapabilities = PiCapabilityBindings,
  TOutput = unknown,
> {
  readonly factories?: PiRuntimeFactories;
  readonly sessionInputs?: PiSessionInputs;
  readonly native?: NativeAgentHarnessOptions;
  readonly hookHandlers?: readonly AgentLifecycleInProcessHookHandler[];
  readonly policy?: AgentHarnessPolicyEvaluator;
  readonly adapters?: AgentHarnessAdapterRegistry<TCapabilities, TOutput>;
}

export interface RunAgentHarnessOptions extends AgentHarnessRunInput<PiCapabilityBindings> {
  readonly factories?: PiRuntimeFactories;
}

type AgentHarnessRolePolicy = "coordinator" | "read-only" | "build" | "verify";
type AgentHarnessTurnMode = NonNullable<NonNullable<AgentHarnessConfig["execution"]>["turnMode"]>;
type PiSessionInputs = ReturnType<typeof resolvePiSessionInputs>;

interface EffectPolicy {
  readonly allow: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly allowByCategory?: Readonly<Record<string, ReadonlySet<AgentHarnessCapabilityEffect>>>;
  readonly denyUnknown: boolean;
}

interface PolicyFilterResult<TTool> {
  readonly tools: readonly TTool[];
  readonly decisions: readonly PolicyDecisionRecord[];
}

interface ArtifactWriteSpec {
  readonly id: string;
  readonly kind: AgentHarnessArtifactRef["kind"];
  readonly fileName: string;
  readonly description: string;
  readonly value: unknown;
}

export const LOCAL_DEV_FULL_POLICY_PROFILE: AgentHarnessPolicyProfileId = "local-dev-full";
export const BENCHMARK_CONTAINER_POLICY_PROFILE: AgentHarnessPolicyProfileId =
  "benchmark-container";

const READ_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  "fs.read",
  "mcp.read",
  "repo.inspect",
  "lsp.read",
  "memory.read",
  "handoff.read",
]);

const HANDOFF_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  "handoff.read",
  "handoff.write",
  "artifact.write",
]);

const MUTATING_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  "fs.write",
  "process.spawn",
  "network.egress",
  "mcp.write",
  "mcp.launch",
  "memory.write",
  "secret.read",
  "sandbox.create",
  "message.send",
  "external.write",
  "payment.spend",
]);

const OPENAI_CODEX_PI_PROVIDER = "openai-codex";

const ALL_LOCAL_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  ...READ_EFFECTS,
  ...HANDOFF_EFFECTS,
  ...MUTATING_EFFECTS,
]);

function effectSet(
  effects: readonly AgentHarnessCapabilityEffect[],
): ReadonlySet<AgentHarnessCapabilityEffect> {
  return new Set<AgentHarnessCapabilityEffect>(effects);
}

const ROLE_EFFECT_POLICIES: Readonly<Record<AgentHarnessRolePolicy, EffectPolicy>> = Object.freeze({
  coordinator: {
    allow: effectSet([...READ_EFFECTS, ...HANDOFF_EFFECTS]),
    denyUnknown: true,
  },
  "read-only": {
    allow: effectSet(READ_EFFECTS),
    denyUnknown: true,
  },
  build: {
    allow: effectSet(ALL_LOCAL_EFFECTS),
    denyUnknown: true,
  },
  verify: {
    allow: effectSet([...READ_EFFECTS, "artifact.write"]),
    allowByCategory: {
      terminal: effectSet([...READ_EFFECTS, "process.spawn", "fs.write", "network.egress"]),
    },
    denyUnknown: true,
  },
});

export const DEFAULT_AGENT_HARNESS_ROLES: readonly AgentHarnessRole[] = Object.freeze([
  {
    id: "planner",
    kind: "planner",
    description: "Decompose the task, identify risks, and produce a concise plan.",
    readOnly: true,
  },
  {
    id: "explorer",
    kind: "explorer",
    description: "Inspect the workspace and gather evidence without changing files.",
    readOnly: true,
  },
  {
    id: "builder",
    kind: "builder",
    description: "Make the requested code, config, or artifact changes.",
  },
  {
    id: "verifier",
    kind: "verifier",
    description: "Run checks and report failures without mutating source files.",
    readOnly: true,
  },
]);

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function isAssistantLikeMessage(value: unknown): value is {
  readonly role: "assistant";
  readonly content: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value
  );
}

function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantLikeMessage(message)) {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("");
    }
  }

  return "";
}

function getToolName(tool: { readonly name?: string }): string {
  const name = tool.name?.trim();
  if (name && name.length > 0) {
    return name;
  }

  return "unknown-tool";
}

function readTrimmedEnv(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePiSessionInputs(modelId: string) {
  const agentDir = resolve(readTrimmedEnv("GENERIC_AI_AGENT_DIR") ?? getAgentDir());
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const apiKey = readTrimmedEnv("GENERIC_AI_PROVIDER_API_KEY");
  if (apiKey !== undefined) {
    authStorage.setRuntimeApiKey(OPENAI_CODEX_PI_PROVIDER, apiKey);
  }

  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const model = modelRegistry.find(OPENAI_CODEX_PI_PROVIDER, modelId);
  if (model === undefined) {
    throw new Error(
      `Pi could not resolve model "${OPENAI_CODEX_PI_PROVIDER}/${modelId}". Set GENERIC_AI_MODEL to a model available in Pi.`,
    );
  }

  return {
    agentDir,
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  };
}

function policyDecision(input: {
  readonly runId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resource: ResourceSelector;
  readonly effect: "allow" | "deny";
  readonly decision: PolicyDecisionRecord["decision"];
  readonly reason: string;
  readonly index?: number;
}): PolicyDecisionRecord {
  return Object.freeze({
    id: `${input.runId}:policy:${input.actorId}:${input.action}:${input.resource.id ?? input.resource.kind}${input.index === undefined ? "" : `:${input.index}`}`,
    runId: input.runId,
    actorId: input.actorId,
    action: input.action,
    resource: input.resource,
    effect: input.effect,
    decision: input.decision,
    reason: input.reason,
    evidenceRefs: Object.freeze([]),
  });
}

function createPolicyEvaluator(_input: {
  readonly runId: string;
  readonly actorId: string;
}): AgentHarnessPolicyEvaluator {
  return Object.freeze({
    async evaluate(
      request: AgentHarnessPolicyEvaluationInput,
    ): Promise<{ readonly decision: PolicyDecisionRecord; readonly allowed: boolean }> {
      const decision = policyDecision({
        runId: request.runId,
        actorId: request.actorId,
        action: request.action,
        resource: request.resource,
        effect: "allow",
        decision: "allowed",
        reason: "Effect request is allowed by the default harness policy evaluator.",
      });

      return Object.freeze({ decision, allowed: true });
    },
  });
}

async function filterToolsByEffect<TTool extends { readonly name?: string }>(input: {
  readonly tools: readonly TTool[] | undefined;
  readonly runId: string;
  readonly actorId: string;
  readonly rolePolicy: AgentHarnessRolePolicy;
  readonly category: string;
  readonly deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly policy: AgentHarnessPolicyEvaluator;
}): Promise<PolicyFilterResult<TTool>> {
  if (input.tools === undefined) {
    return Object.freeze({
      tools: Object.freeze([]),
      decisions: Object.freeze([]),
    });
  }

  const policy = ROLE_EFFECT_POLICIES[input.rolePolicy];
  const allowedEffects = policy.allowByCategory?.[input.category] ?? policy.allow;
  const decisions: PolicyDecisionRecord[] = [];
  const allowedTools: TTool[] = [];

  for (const [index, tool] of input.tools.entries()) {
    const name = getToolName(tool);
    const effects = getAgentHarnessToolEffects(tool);
    const deniedEffects =
      effects.length === 0 && policy.denyUnknown
        ? ["custom.unknown" as AgentHarnessCapabilityEffect]
        : effects.filter(
            (effect) => !allowedEffects.has(effect) || input.deniedEffects.has(effect),
          );

    if (deniedEffects.length > 0) {
      decisions.push(
        policyDecision({
          runId: input.runId,
          actorId: input.actorId,
          action: "bind_tool",
          resource: {
            kind: "tool",
            id: name,
          },
          effect: "deny",
          decision: "denied",
          reason: `Denied ${input.category} tool "${name}" for ${input.rolePolicy} role policy because of effect(s): ${deniedEffects.join(", ")}.`,
          index,
        }),
      );
      continue;
    }

    const evaluation = await input.policy.evaluate({
      runId: input.runId,
      actorId: input.actorId,
      action: "bind_tool",
      resource: {
        kind: "tool",
        id: name,
      },
      effects,
      metadata: jsonObject({
        category: input.category,
        rolePolicy: input.rolePolicy,
      }),
    });
    decisions.push(evaluation.decision);
    if (!evaluation.allowed) {
      continue;
    }

    allowedTools.push(tool);
  }

  return Object.freeze({
    tools: Object.freeze(allowedTools),
    decisions: Object.freeze(decisions),
  });
}

function allowsAllEffects(
  rolePolicy: AgentHarnessRolePolicy,
  effects: readonly AgentHarnessCapabilityEffect[],
  deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>,
): boolean {
  const policy = ROLE_EFFECT_POLICIES[rolePolicy];
  return effects.every((effect) => policy.allow.has(effect) && !deniedEffects.has(effect));
}

async function evaluateCapabilityBinding(input: {
  readonly runId: string;
  readonly actorId: string;
  readonly rolePolicy: AgentHarnessRolePolicy;
  readonly capabilityId: string;
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  readonly deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly policy: AgentHarnessPolicyEvaluator;
  readonly decisions: PolicyDecisionRecord[];
}): Promise<boolean> {
  if (!allowsAllEffects(input.rolePolicy, input.effects, input.deniedEffects)) {
    input.decisions.push(
      capabilityDeniedDecision({
        runId: input.runId,
        actorId: input.actorId,
        rolePolicy: input.rolePolicy,
        capabilityId: input.capabilityId,
        effects: input.effects,
      }),
    );
    return false;
  }

  const evaluation = await input.policy.evaluate({
    runId: input.runId,
    actorId: input.actorId,
    action: "bind_capability",
    resource: {
      kind: "custom",
      id: input.capabilityId,
    },
    effects: input.effects,
    metadata: jsonObject({
      rolePolicy: input.rolePolicy,
    }),
  });
  input.decisions.push(evaluation.decision);
  return evaluation.allowed;
}

function capabilityDeniedDecision(input: {
  readonly runId: string;
  readonly actorId: string;
  readonly rolePolicy: AgentHarnessRolePolicy;
  readonly capabilityId: string;
  readonly effects: readonly AgentHarnessCapabilityEffect[];
}): PolicyDecisionRecord {
  return policyDecision({
    runId: input.runId,
    actorId: input.actorId,
    action: "bind_capability",
    resource: {
      kind: "custom",
      id: input.capabilityId,
    },
    effect: "deny",
    decision: "denied",
    reason: `Denied capability "${input.capabilityId}" for ${input.rolePolicy} role policy because it exposes effect(s): ${input.effects.join(", ")}.`,
  });
}

async function applyRolePolicy(input: {
  readonly capabilities: PiCapabilityBindings;
  readonly rolePolicy: AgentHarnessRolePolicy;
  readonly runId: string;
  readonly actorId: string;
  readonly policy: AgentHarnessPolicyEvaluator;
  readonly deniedEffects?: ReadonlySet<AgentHarnessCapabilityEffect>;
}): Promise<{
  readonly capabilities: PiCapabilityBindings;
  readonly policyDecisions: readonly PolicyDecisionRecord[];
}> {
  const deniedEffects = input.deniedEffects ?? new Set<AgentHarnessCapabilityEffect>();
  const terminalTools = await filterToolsByEffect({
    tools:
      input.capabilities.terminalTools === undefined
        ? undefined
        : [input.capabilities.terminalTools.tool],
    runId: input.runId,
    actorId: input.actorId,
    rolePolicy: input.rolePolicy,
    category: "terminal",
    deniedEffects,
    policy: input.policy,
  });
  const fileTools = await filterToolsByEffect({
    tools: input.capabilities.fileTools?.piTools,
    runId: input.runId,
    actorId: input.actorId,
    rolePolicy: input.rolePolicy,
    category: "file",
    deniedEffects,
    policy: input.policy,
  });
  const customTools = await filterToolsByEffect({
    tools: input.capabilities.customTools,
    runId: input.runId,
    actorId: input.actorId,
    rolePolicy: input.rolePolicy,
    category: "custom",
    deniedEffects,
    policy: input.policy,
  });
  const decisions = [...terminalTools.decisions, ...fileTools.decisions, ...customTools.decisions];
  const mcpEffects: readonly AgentHarnessCapabilityEffect[] = [
    "mcp.read",
    "mcp.launch",
    "secret.read",
  ];
  const messagingEffects: readonly AgentHarnessCapabilityEffect[] = [
    "handoff.read",
    "handoff.write",
  ];
  const memoryEffects: readonly AgentHarnessCapabilityEffect[] = ["memory.read", "memory.write"];
  const includeMcp =
    input.capabilities.mcp !== undefined &&
    (await evaluateCapabilityBinding({
      runId: input.runId,
      actorId: input.actorId,
      rolePolicy: input.rolePolicy,
      capabilityId: "mcp",
      effects: mcpEffects,
      deniedEffects,
      policy: input.policy,
      decisions,
    }));
  const includeMessaging =
    input.capabilities.messaging !== undefined &&
    (await evaluateCapabilityBinding({
      runId: input.runId,
      actorId: input.actorId,
      rolePolicy: input.rolePolicy,
      capabilityId: "messaging",
      effects: messagingEffects,
      deniedEffects,
      policy: input.policy,
      decisions,
    }));
  const includeMemory =
    input.capabilities.memory !== undefined &&
    (await evaluateCapabilityBinding({
      runId: input.runId,
      actorId: input.actorId,
      rolePolicy: input.rolePolicy,
      capabilityId: "memory",
      effects: memoryEffects,
      deniedEffects,
      policy: input.policy,
      decisions,
    }));

  return {
    capabilities: {
      ...(terminalTools.tools[0] === undefined
        ? {}
        : { terminalTools: { tool: terminalTools.tools[0] } }),
      ...(fileTools.tools.length === 0 ? {} : { fileTools: { piTools: fileTools.tools } }),
      ...(customTools.tools.length === 0 ? {} : { customTools: customTools.tools }),
      ...(input.capabilities.skills === undefined ? {} : { skills: input.capabilities.skills }),
      ...(includeMessaging ? { messaging: input.capabilities.messaging } : {}),
      ...(includeMemory ? { memory: input.capabilities.memory } : {}),
      ...(includeMcp ? { mcp: input.capabilities.mcp } : {}),
    },
    policyDecisions: Object.freeze(decisions),
  };
}

function policyForRole(role: AgentHarnessRole, isRoot: boolean): AgentHarnessRolePolicy {
  if (isRoot || role.kind === "root") {
    return "coordinator";
  }

  if (role.kind === "builder") {
    return "build";
  }

  if (role.kind === "verifier") {
    return "verify";
  }

  return "read-only";
}

function resolveRoles(config: AgentHarnessConfig): readonly AgentHarnessRole[] {
  return config.roles && config.roles.length > 0 ? config.roles : DEFAULT_AGENT_HARNESS_ROLES;
}

function roleDirectory(roles: readonly AgentHarnessRole[]): string {
  return roles
    .map((role) => {
      const readOnly = role.readOnly ? " read-only" : "";
      const description = role.description ? `: ${role.description}` : "";
      return `- ${role.id} (${role.kind}${readOnly})${description}`;
    })
    .join("\n");
}

function stopToolRunInstruction(turnMode: AgentHarnessTurnMode | undefined): string {
  if (turnMode === "single-turn") {
    return "This run is configured for single-turn compatibility. Finish with a concise assistant response; do not call a terminal stop tool.";
  }

  return "The runtime loops until you call stop_and_respond. Use that tool for the final response once the task is complete, blocked, or failed.";
}

function stopToolHandoffInstruction(turnMode: AgentHarnessTurnMode | undefined): string {
  if (turnMode === "single-turn") {
    return "This delegated run is configured for single-turn compatibility. Return the handoff as a normal assistant response.";
  }

  return "The runtime loops until you call stop_and_respond. Use that tool to return your handoff.";
}

function buildRootPrompt(input: {
  readonly instruction: string;
  readonly roles: readonly AgentHarnessRole[];
  readonly policyProfile: AgentHarnessPolicyProfileId;
  readonly turnMode?: AgentHarnessTurnMode;
}): string {
  return [
    "You are the root coordinator for a Generic AI composable agent harness run.",
    "Use model-directed Plan/Explore/Build/Verify topology. Delegate whenever another role should do focused work.",
    "Planner and explorer roles are read-only. Builder may edit and run terminal commands. Verifier may run terminal checks but must not use file write/edit tools.",
    "Before finishing, delegate a verifier pass that reruns the important command from the final state instead of trusting stale builder logs.",
    "Keep durable handoffs in the delegation messages and preserve concrete evidence from tools.",
    `Policy profile: ${input.policyProfile}.`,
    stopToolRunInstruction(input.turnMode),
    "",
    "Available roles:",
    roleDirectory(input.roles),
    "",
    "Use delegate_agent with roleId and task to hand work to a role. Finish only after useful verification or a clear blocker.",
    "",
    "User task:",
    input.instruction,
  ].join("\n");
}

function buildRolePrompt(input: {
  readonly role: AgentHarnessRole;
  readonly instruction: string;
  readonly parentTask: string;
  readonly turnMode?: AgentHarnessTurnMode;
}): string {
  return [
    `You are role "${input.role.id}" (${input.role.kind}) inside a Generic AI harness run.`,
    input.role.description ?? "",
    input.role.instructions ?? "",
    input.role.readOnly
      ? "This role is read-only by default. Do not mutate files unless explicitly permitted by the coordinator."
      : "",
    "",
    "Delegated task:",
    input.instruction,
    "",
    "Parent task:",
    input.parentTask,
    "",
    "Return a concise handoff with actions taken, evidence, blockers, and recommended next step.",
    stopToolHandoffInstruction(input.turnMode),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function createTextResult(summary: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: summary }],
    details,
  };
}

function createPolicyDecisions(input: {
  readonly runId: string;
  readonly actorId: string;
  readonly profile: AgentHarnessPolicyProfileId;
  readonly allowNetwork: boolean;
  readonly allowMcp: boolean;
}): readonly PolicyDecisionRecord[] {
  const decisions: PolicyDecisionRecord[] = [];
  const common = {
    runId: input.runId,
    actorId: input.actorId,
    evidenceRefs: [],
  } satisfies Pick<PolicyDecisionRecord, "runId" | "actorId" | "evidenceRefs">;

  decisions.push({
    ...common,
    id: `${input.runId}:policy:workspace`,
    action: "share_workspace",
    resource: { kind: "space", id: "workspace" },
    effect: "allow",
    decision: "allowed",
    reason: "Harness roles share one workspace by design.",
  });

  decisions.push({
    ...common,
    id: `${input.runId}:policy:nested-sandbox`,
    action: "create_nested_sandbox",
    resource: { kind: "sandbox", id: "nested" },
    effect: input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE ? "deny" : "allow",
    decision: input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE ? "denied" : "allowed",
    reason:
      input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE
        ? "Benchmark runs use the harness container as the execution boundary."
        : "Local development profile allows local sandbox experiments.",
  });

  decisions.push({
    ...common,
    id: `${input.runId}:policy:network`,
    action: "network_access",
    resource: { kind: "custom", id: "network" },
    effect: input.allowNetwork ? "allow" : "deny",
    decision: input.allowNetwork ? "allowed" : "denied",
    reason: input.allowNetwork
      ? "Network access was explicitly allowed for this harness run."
      : "Network access defaults to denied for this harness profile.",
  });

  decisions.push({
    ...common,
    id: `${input.runId}:policy:mcp`,
    action: "mcp_launch",
    resource: { kind: "custom", id: "mcp" },
    effect: input.allowMcp ? "allow" : "deny",
    decision: input.allowMcp ? "allowed" : "denied",
    reason: input.allowMcp
      ? "MCP access was explicitly allowed for this harness run."
      : "MCP launch defaults to denied for this harness profile.",
  });

  return Object.freeze(decisions);
}

function shouldPassMcp(input: {
  readonly capabilities: PiCapabilityBindings;
  readonly profile: AgentHarnessPolicyProfileId;
  readonly allowMcp: boolean;
}): boolean {
  return (
    input.capabilities.mcp !== undefined &&
    (input.profile !== BENCHMARK_CONTAINER_POLICY_PROFILE || input.allowMcp)
  );
}

function applyProfilePolicy(
  capabilities: PiCapabilityBindings,
  profile: AgentHarnessPolicyProfileId,
  allowMcp: boolean,
): PiCapabilityBindings {
  return {
    ...(capabilities.terminalTools === undefined
      ? {}
      : { terminalTools: capabilities.terminalTools }),
    ...(capabilities.fileTools === undefined ? {} : { fileTools: capabilities.fileTools }),
    ...(capabilities.customTools === undefined ? {} : { customTools: capabilities.customTools }),
    ...(shouldPassMcp({ capabilities, profile, allowMcp }) ? { mcp: capabilities.mcp } : {}),
    ...(capabilities.skills === undefined ? {} : { skills: capabilities.skills }),
    ...(capabilities.messaging === undefined ? {} : { messaging: capabilities.messaging }),
    ...(capabilities.memory === undefined ? {} : { memory: capabilities.memory }),
    ...(capabilities.secrets === undefined ? {} : { secrets: capabilities.secrets }),
  };
}

function wrapCapabilitiesWithHooks(input: {
  readonly capabilities: PiCapabilityBindings;
  readonly executor: AgentLifecycleHookExecutor;
  readonly context: Omit<AgentLifecycleHookContext, "event">;
}): PiCapabilityBindings {
  if (!input.executor.enabled) {
    return input.capabilities;
  }

  return {
    ...(input.capabilities.terminalTools === undefined
      ? {}
      : {
          terminalTools: {
            tool: wrapToolWithLifecycleHooks(input.capabilities.terminalTools.tool, {
              executor: input.executor,
              baseContext: input.context,
            }),
          },
        }),
    ...(input.capabilities.fileTools === undefined
      ? {}
      : {
          fileTools: {
            piTools: input.capabilities.fileTools.piTools.map((tool) =>
              wrapToolWithLifecycleHooks(tool, {
                executor: input.executor,
                baseContext: input.context,
              }),
            ),
          },
        }),
    ...(input.capabilities.customTools === undefined
      ? {}
      : {
          customTools: input.capabilities.customTools.map((tool) =>
            wrapToolWithLifecycleHooks(tool, {
              executor: input.executor,
              baseContext: input.context,
            }),
          ),
        }),
    ...(input.capabilities.mcp === undefined ? {} : { mcp: input.capabilities.mcp }),
    ...(input.capabilities.skills === undefined ? {} : { skills: input.capabilities.skills }),
    ...(input.capabilities.messaging === undefined
      ? {}
      : { messaging: input.capabilities.messaging }),
    ...(input.capabilities.memory === undefined ? {} : { memory: input.capabilities.memory }),
  };
}

function createSessionLifecycleHooks(input: {
  readonly executor: AgentLifecycleHookExecutor;
  readonly context: Omit<AgentLifecycleHookContext, "event">;
}) {
  if (!input.executor.enabled) {
    return undefined;
  }

  return {
    async onSessionStart(sessionContext: {
      readonly rootSessionId: string;
      readonly sessionId: string;
      readonly parentSessionId?: string;
    }): Promise<void> {
      await input.executor.run({
        ...input.context,
        ...sessionContext,
        event: "SessionStart",
      });
    },
    async onUserPromptSubmit(
      sessionContext: {
        readonly rootSessionId: string;
        readonly sessionId: string;
        readonly parentSessionId?: string;
      },
      prompt: string,
    ): Promise<string> {
      const result = await input.executor.run({
        ...input.context,
        ...sessionContext,
        event: "UserPromptSubmit",
        prompt,
      });
      if (result.blocked) {
        throw new Error(
          firstHookBlockReason(result.decisions) ?? "UserPromptSubmit hook blocked prompt.",
        );
      }
      return appendHookContext(result.prompt ?? prompt, result.additionalContext);
    },
    async onStop(sessionContext: {
      readonly rootSessionId: string;
      readonly sessionId: string;
      readonly parentSessionId?: string;
    }): Promise<void> {
      const result = await input.executor.run({
        ...input.context,
        ...sessionContext,
        event: "Stop",
      });
      if (result.blocked) {
        throw new Error(firstHookBlockReason(result.decisions) ?? "Stop hook blocked completion.");
      }
    },
  };
}

async function observePermissionDecisions(input: {
  readonly executor: AgentLifecycleHookExecutor;
  readonly context: Omit<AgentLifecycleHookContext, "event">;
  readonly decisions: readonly PolicyDecisionRecord[];
  readonly sessionContext?: {
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly parentSessionId?: string;
  };
}): Promise<void> {
  if (!input.executor.enabled) {
    return;
  }

  for (const decision of input.decisions) {
    await input.executor.run({
      ...input.context,
      ...(input.sessionContext ?? {}),
      event: "PermissionRequest",
      action: decision.action,
      resource: decision.resource,
      policyDecision: decision,
    });
  }
}

function firstHookBlockReason(
  decisions: readonly AgentLifecycleHookDecisionRecord[],
): string | undefined {
  return decisions.find((decision) => decision.decision === "block")?.reason;
}

function profileDeniedEffects(input: {
  readonly profile: AgentHarnessPolicyProfileId;
  readonly allowNetwork: boolean;
  readonly allowMcp: boolean;
}): ReadonlySet<AgentHarnessCapabilityEffect> {
  const effects = new Set<AgentHarnessCapabilityEffect>();
  if (input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE || !input.allowNetwork) {
    effects.add("network.egress");
  }
  if (input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE || !input.allowMcp) {
    effects.add("mcp.read");
    effects.add("mcp.write");
    effects.add("mcp.launch");
    effects.add("secret.read");
  }
  if (input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE) {
    effects.add("sandbox.create");
    // Benchmarks never reach real people, external records or money.
    effects.add("message.send");
    effects.add("external.write");
    effects.add("payment.spend");
  }
  return effects;
}

function jsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  return Object.freeze({ ...value }) as JsonObject;
}

async function emitPolicyDecision(
  eventStream: CanonicalEventStream,
  input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly decision: PolicyDecisionRecord;
  },
): Promise<void> {
  await eventStream.emit({
    runId: input.runId,
    scopeId: input.scopeId,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    name: "policy.decision",
    data: jsonObject({
      policyDecisionId: input.decision.id,
      actorId: input.decision.actorId,
      action: input.decision.action,
      resource: input.decision.resource as unknown as JsonObject,
      decision: input.decision.decision,
      effect: input.decision.effect,
      reason: input.decision.reason,
    }),
  });
}

function isTerminalTool(toolName: string | undefined): boolean {
  return toolName === "bash" || toolName === "terminal" || toolName === "shell";
}

function projectEventType(event: CanonicalEvent): AgentHarnessEventType {
  switch (event.name) {
    case "run.started":
      return "run.started";
    case "run.completed":
      return "run.completed";
    case "run.failed":
      return "run.failed";
    case "session.started":
      return "session.started";
    case "session.completed":
      return "session.completed";
    case "session.failed":
      return "session.failed";
    case "policy.decision":
      return "policy.decision";
    case "hook.execution.started":
      return "hook.execution.started";
    case "hook.execution.completed":
      return "hook.execution.completed";
    case "hook.execution.failed":
      return "hook.execution.failed";
    case "hook.decision":
      return "hook.decision";
    case "artifact.created":
      return "artifact.created";
    case "handoff.requested":
      return "handoff.requested";
    case "handoff.accepted":
      return "handoff.accepted";
    case "handoff.completed":
      return "handoff.completed";
    case "handoff.failed":
      return "handoff.failed";
    default:
      break;
  }

  const runtimeType = event.data["type"];
  const toolName = typeof event.data["toolName"] === "string" ? event.data["toolName"] : undefined;
  if (runtimeType === "tool_execution_start") {
    return isTerminalTool(toolName) ? "terminal.command.started" : "tool.call.started";
  }
  if (runtimeType === "tool_execution_end") {
    const failed = event.data["isError"] === true;
    if (isTerminalTool(toolName)) {
      return failed ? "terminal.command.failed" : "terminal.command.completed";
    }
    return failed ? "tool.call.failed" : "tool.call.completed";
  }
  if (runtimeType === "compaction_start") {
    return "session.compaction.started";
  }
  if (runtimeType === "compaction_end") {
    return "session.compaction.completed";
  }

  return "model.message";
}

function projectEvent(event: CanonicalEvent): AgentHarnessEventProjection {
  const data = jsonObject(event.data);
  const toolName = typeof event.data["toolName"] === "string" ? event.data["toolName"] : undefined;
  const roleId =
    typeof event.data["roleId"] === "string"
      ? event.data["roleId"]
      : typeof event.data["actorId"] === "string"
        ? event.data["actorId"]
        : undefined;
  const type = projectEventType(event);

  return Object.freeze({
    id: event.eventId,
    sequence: event.sequence,
    type,
    eventName: event.name,
    occurredAt: event.occurredAt,
    ...(roleId === undefined ? {} : { roleId }),
    ...(toolName === undefined ? {} : { toolName }),
    summary: summarizeEvent(event),
    data,
  });
}

function summarizeEvent(event: CanonicalEvent): string {
  const type = projectEventType(event);
  if (type.startsWith("handoff.")) {
    const roleId = typeof event.data["roleId"] === "string" ? event.data["roleId"] : "unknown";
    return `${event.name} for role ${roleId}.`;
  }

  if (type.startsWith("tool.call.") || type.startsWith("terminal.command.")) {
    const toolName =
      typeof event.data["toolName"] === "string" ? event.data["toolName"] : "unknown";
    return `${type} ${toolName}.`;
  }

  return event.name;
}

/**
 * One capability-bound agent session, independent of the runtime that executes it. The harness
 * applies role policy, lifecycle hooks, delegation, and artifact writing around a backend, so the
 * pi runtime and the native runtime share all of that plumbing.
 */
export interface HarnessSessionRunOptions {
  readonly cwd: string;
  readonly capabilities: PiCapabilityBindings;
  readonly prompt: string;
  /** The role this session runs as. Its `model` overrides the harness model. */
  readonly role?: AgentHarnessRole;
  readonly turnMode?: AgentHarnessTurnMode;
  readonly maxTurns?: number;
  readonly runId: string;
  readonly rootScopeId: string;
  readonly rootAgentId: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly signal?: AbortSignal;
  readonly eventStream: CanonicalEventStream;
  readonly lifecycleHooks?: PiCapabilitySessionLifecycleHooks;
  readonly onSessionReady?: (context: CapabilityPiSessionEventContext) => Promise<void> | void;
  /**
   * The run's usage meter, shared by every session of the run. Backends that report model usage
   * (native) route each response through it; the meter's signal is already merged into `signal`.
   */
  readonly usageMeter?: UsageMeter;
}

export interface HarnessSessionRunResult {
  readonly sessionId: string;
  readonly outputText: string;
  readonly failureMessage?: string;
  readonly events: readonly CanonicalEvent[];
  readonly envelope: RunEnvelope;
}

export interface HarnessSessionBackend {
  readonly kind: AgentHarnessAdapterKind;
  /** Human-readable runtime name for messages. */
  readonly label: string;
  run(options: HarnessSessionRunOptions): Promise<HarnessSessionRunResult>;
}

function createPiSessionBackend(
  config: AgentHarnessConfig,
  options: Pick<CreateAgentHarnessOptions, "factories" | "sessionInputs">,
): HarnessSessionBackend {
  const sessionInputsByModel = new Map<string, PiSessionInputs>();
  const sessionInputsFor = (role: AgentHarnessRole | undefined): PiSessionInputs => {
    if (options.sessionInputs !== undefined) {
      return options.sessionInputs;
    }
    const modelId = role?.model ?? config.model ?? DEFAULT_OPENAI_CODEX_MODEL;
    let inputs = sessionInputsByModel.get(modelId);
    if (inputs === undefined) {
      inputs = resolvePiSessionInputs(modelId);
      sessionInputsByModel.set(modelId, inputs);
    }
    return inputs;
  };

  return Object.freeze({
    kind: "pi" as const,
    label: "Pi",
    async run(runOptions: HarnessSessionRunOptions): Promise<HarnessSessionRunResult> {
      const { role, cwd, usageMeter: _usageMeter, ...rest } = runOptions;
      const sessionInputs = sessionInputsFor(role);
      const piOptions = {
        ...rest,
        cwd,
        agentDir: sessionInputs.agentDir,
        authStorage: sessionInputs.authStorage as never,
        modelRegistry: sessionInputs.modelRegistry as never,
        model: sessionInputs.model as never,
        sessionManager: sessionInputs.sessionManager as never,
        settingsManager: sessionInputs.settingsManager as never,
      };
      const result =
        options.factories === undefined
          ? await runCapabilityPiAgentSession(piOptions)
          : await runCapabilityPiAgentSession(piOptions, options.factories);
      return {
        sessionId: result.session.sessionId,
        outputText: result.outputText ?? extractLatestAssistantText(result.session.messages),
        ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
        events: result.events,
        envelope: result.envelope,
      };
    },
  });
}

function createNativeSessionBackend(
  config: AgentHarnessConfig,
  options: NativeAgentHarnessOptions,
): HarnessSessionBackend {
  const modelsByRef = new Map<string, Model>();
  const modelFor = (role: AgentHarnessRole | undefined): Model => {
    const ref = role?.model ?? config.model ?? DEFAULT_NATIVE_MODEL;
    let model = modelsByRef.get(ref);
    if (model === undefined) {
      model = (options.resolveModel ?? resolveNativeModel)(ref);
      modelsByRef.set(ref, model);
    }
    return model;
  };
  const apiKeyFor = (model: Model): string | undefined =>
    options.apiKey ??
    resolveApiKey(model.provider) ??
    readTrimmedEnv("GENERIC_AI_PROVIDER_API_KEY");

  return Object.freeze({
    kind: "native" as const,
    label: "native",
    async run(runOptions: HarnessSessionRunOptions): Promise<HarnessSessionRunResult> {
      const { role, usageMeter, ...rest } = runOptions;
      const model = modelFor(role);
      const apiKey = apiKeyFor(model);
      const result = await runCapabilityNativeAgentSession({
        ...rest,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(options.sessionDir === undefined
          ? {}
          : { sessionManager: NativeSessionManager.create(rest.cwd, options.sessionDir) }),
        ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(usageMeter === undefined
          ? {}
          : { usageMeter, usageAttribution: { roleId: role?.id ?? rest.rootAgentId } }),
      });
      return {
        sessionId: result.sessionId,
        outputText: result.outputText ?? "",
        ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
        events: result.events,
        envelope: result.envelope,
      };
    },
  });
}

interface RoleSessionResult {
  readonly outputText: string;
  readonly failureMessage?: string;
  readonly events: readonly CanonicalEvent[];
  readonly sessionId: string;
}

/**
 * Run one harness role as its own session on the harness backend, applying the role's effect
 * policy, lifecycle hooks, and policy-decision tracing. Shared by the
 * model-directed `delegate_agent` tool and the protocol-driven topology runner.
 */
async function runRoleSession(input: {
  readonly runId: string;
  readonly rootScopeId: string;
  readonly workspaceRoot: string;
  readonly role: AgentHarnessRole;
  readonly prompt: string;
  readonly turnMode?: AgentHarnessTurnMode;
  readonly maxTurns?: number;
  readonly capabilities: PiCapabilityBindings;
  readonly deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly hookExecutor: AgentLifecycleHookExecutor;
  readonly policy: AgentHarnessPolicyEvaluator;
  readonly signal?: AbortSignal;
  readonly eventStream: CanonicalEventStream;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly recordPolicyDecisions: (decisions: readonly PolicyDecisionRecord[]) => void;
  readonly backend: HarnessSessionBackend;
  readonly usageMeter?: UsageMeter;
}): Promise<RoleSessionResult> {
  const { role } = input;
  const rolePolicy = policyForRole(role, false);
  const rolePolicyResult = await applyRolePolicy({
    capabilities: input.capabilities,
    rolePolicy,
    runId: input.runId,
    actorId: role.id,
    deniedEffects: input.deniedEffects,
    policy: input.policy,
  });
  input.recordPolicyDecisions(rolePolicyResult.policyDecisions);
  const secrets = input.capabilities.secrets;
  const roleSecretsCapabilities = wrapCapabilitiesWithSecrets({
    capabilities: rolePolicyResult.capabilities,
    secrets,
    actorId: role.id,
    grants: role.secrets,
    runId: input.runId,
    onAccess: async (record) => {
      const decision = secretAccessPolicyDecision(record);
      input.recordPolicyDecisions([decision]);
      const sessionId = input.rootSessionId ?? input.runId;
      await emitPolicyDecision(input.eventStream, {
        runId: input.runId,
        scopeId: input.rootScopeId,
        rootSessionId: sessionId,
        sessionId: input.parentSessionId ?? sessionId,
        decision,
      });
    },
  });
  const rolePrompt = `${input.prompt}${await secretsPromptGuidance(secrets, role.secrets)}`;
  const roleHookContext = {
    runId: input.runId,
    scopeId: input.rootScopeId,
    ...(input.rootSessionId === undefined
      ? {}
      : { rootSessionId: input.rootSessionId, sessionId: input.rootSessionId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    actorId: role.id,
    roleId: role.id,
  };
  const roleCapabilities = wrapCapabilitiesWithHooks({
    capabilities: roleSecretsCapabilities,
    executor: input.hookExecutor,
    context: roleHookContext,
  });
  const roleLifecycleHooks = createSessionLifecycleHooks({
    executor: input.hookExecutor,
    context: roleHookContext,
  });
  const roleResult = await input.backend.run({
    cwd: input.workspaceRoot,
    role,
    capabilities: roleCapabilities,
    prompt: rolePrompt,
    ...(input.turnMode === undefined ? {} : { turnMode: input.turnMode }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    runId: input.runId,
    rootScopeId: input.rootScopeId,
    rootAgentId: role.id,
    ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    eventStream: input.eventStream,
    ...(input.usageMeter === undefined ? {} : { usageMeter: input.usageMeter }),
    ...(roleLifecycleHooks === undefined ? {} : { lifecycleHooks: roleLifecycleHooks }),
    onSessionReady: async (context: CapabilityPiSessionEventContext) => {
      await observePermissionDecisions({
        executor: input.hookExecutor,
        context: roleHookContext,
        decisions: rolePolicyResult.policyDecisions,
        sessionContext: context,
      });
      for (const decision of rolePolicyResult.policyDecisions) {
        await emitPolicyDecision(input.eventStream, {
          runId: input.runId,
          scopeId: input.rootScopeId,
          rootSessionId: context.rootSessionId,
          sessionId: context.sessionId,
          decision,
        });
      }
    },
  });
  return {
    outputText: roleResult.outputText,
    ...(roleResult.failureMessage === undefined
      ? {}
      : { failureMessage: roleResult.failureMessage }),
    events: roleResult.events,
    sessionId: roleResult.sessionId,
  };
}

function createDelegateTool(input: {
  readonly runId: string;
  readonly rootScopeId: string;
  readonly rootAgentId: string;
  readonly workspaceRoot: string;
  readonly instruction: string;
  readonly turnMode?: NonNullable<AgentHarnessConfig["execution"]>["turnMode"];
  readonly maxTurns?: NonNullable<AgentHarnessConfig["execution"]>["maxTurns"];
  readonly roles: readonly AgentHarnessRole[];
  readonly capabilities: PiCapabilityBindings;
  readonly deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly hookExecutor: AgentLifecycleHookExecutor;
  readonly policy: AgentHarnessPolicyEvaluator;
  readonly signal?: AbortSignal;
  readonly eventStream: CanonicalEventStream;
  readonly getRootSessionId: () => string | undefined;
  readonly recordPolicyDecisions: (decisions: readonly PolicyDecisionRecord[]) => void;
  readonly backend: HarnessSessionBackend;
  readonly usageMeter?: UsageMeter;
}): ToolDefinition {
  const rolesById = new Map(input.roles.map((role) => [role.id, role]));

  return withAgentHarnessToolEffects(
    defineTool({
      name: "delegate_agent",
      label: "Delegate Agent",
      description: "Delegate a focused task to a Plan/Explore/Build/Verify harness role.",
      promptSnippet: "delegate focused work to another harness role",
      promptGuidelines: [
        "Use delegate_agent when planning, exploration, building, or verification should be isolated.",
        "Give the delegated role a concrete task and expected output artifact.",
      ],
      parameters: Type.Object({
        roleId: Type.String({
          description: "Role id to delegate to, such as planner, explorer, builder, or verifier.",
        }),
        task: Type.String({
          description: "Focused task for the delegated role.",
        }),
      }),
      async execute(_toolCallId, params) {
        const role = rolesById.get(params.roleId);
        if (role === undefined) {
          throw new Error(`Unknown harness role "${params.roleId}".`);
        }

        const delegationId = `${input.runId}:delegation:${randomUUID()}`;
        const rootSessionId = input.getRootSessionId();
        if (rootSessionId === undefined) {
          throw new Error(
            `Cannot delegate before the root ${input.backend.label} session is ready.`,
          );
        }
        const eventContext = {
          runId: input.runId,
          scopeId: input.rootScopeId,
          rootSessionId,
          sessionId: rootSessionId,
          delegationId,
        };
        await input.eventStream.emit({
          ...eventContext,
          name: "handoff.requested",
          data: {
            roleId: role.id,
            task: params.task,
          },
        });
        await input.eventStream.emit({
          ...eventContext,
          name: "handoff.accepted",
          data: {
            roleId: role.id,
          },
        });

        const roleResult = await runRoleSession({
          runId: input.runId,
          rootScopeId: input.rootScopeId,
          workspaceRoot: input.workspaceRoot,
          backend: input.backend,
          role,
          prompt: buildRolePrompt({
            role,
            instruction: params.task,
            parentTask: input.instruction,
            ...(input.turnMode === undefined ? {} : { turnMode: input.turnMode }),
          }),
          ...(input.turnMode === undefined ? {} : { turnMode: input.turnMode }),
          ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
          capabilities: input.capabilities,
          deniedEffects: input.deniedEffects,
          hookExecutor: input.hookExecutor,
          policy: input.policy,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          eventStream: input.eventStream,
          rootSessionId,
          parentSessionId: rootSessionId,
          recordPolicyDecisions: input.recordPolicyDecisions,
          ...(input.usageMeter === undefined ? {} : { usageMeter: input.usageMeter }),
        });
        const outputText = roleResult.outputText;

        await input.eventStream.emit({
          ...eventContext,
          name: roleResult.failureMessage === undefined ? "handoff.completed" : "handoff.failed",
          data: {
            roleId: role.id,
            status: roleResult.failureMessage === undefined ? "succeeded" : "failed",
            outputText,
            ...(roleResult.failureMessage === undefined
              ? {}
              : { failureMessage: roleResult.failureMessage }),
          },
        });

        return createTextResult(`Role "${role.id}" completed delegation.`, {
          roleId: role.id,
          status: roleResult.failureMessage === undefined ? "succeeded" : "failed",
          outputText,
          eventCount: roleResult.events.length,
        });
      },
    }),
    ["handoff.write", "handoff.read", "artifact.write"],
  );
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function sanitizeArtifactPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function createLocalArtifactStore(input: {
  readonly runId: string;
  readonly artifactDir: string;
}): AgentHarnessArtifactStore {
  return Object.freeze({
    async write(artifact: AgentHarnessArtifactWriteInput): Promise<AgentHarnessArtifactRef> {
      await mkdir(input.artifactDir, { recursive: true });
      const namespace = sanitizeArtifactPathSegment(artifact.namespace ?? "default");
      const id = sanitizeArtifactPathSegment(artifact.id);
      const localPath = join(input.artifactDir, namespace, `${id}.json`);
      const tempPath = `${localPath}.${process.pid}.${randomUUID()}.tmp`;
      const bytes = toBytes(artifact.bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await mkdir(join(input.artifactDir, namespace), { recursive: true });
      await writeFile(tempPath, bytes);
      await rename(tempPath, localPath);

      return Object.freeze({
        id: artifact.id,
        kind: artifact.kind,
        uri: `generic-ai-artifact://${input.runId}/${namespace}/${id}`,
        sha256,
        localPath,
        ...(artifact.ownerId === undefined ? {} : { ownerId: artifact.ownerId }),
        namespace,
        ...(artifact.description === undefined ? {} : { description: artifact.description }),
        ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
      });
    },
  });
}

function createEventSink(): {
  readonly sink: AgentHarnessEventSink;
  readonly snapshot: () => readonly AgentHarnessEventProjection[];
} {
  const projections: AgentHarnessEventProjection[] = [];
  return Object.freeze({
    sink: Object.freeze({
      async emit(event: AgentHarnessEventProjection): Promise<void> {
        projections.push(event);
      },
    }),
    snapshot: () => Object.freeze([...projections]),
  });
}

function createDeadlineSignal(
  context: Pick<AgentHarnessAdapterRunContext, "signal" | "deadline">,
): {
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
} {
  if (context.deadline === undefined) {
    return {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(0, context.deadline.getTime() - Date.now());
  const timeout = setTimeout(() => {
    controller.abort(new Error("Harness run deadline elapsed during Pi adapter execution."));
  }, timeoutMs);
  const abortFromParent = () => {
    controller.abort(context.signal?.reason);
  };

  if (context.signal?.aborted) {
    abortFromParent();
  } else {
    context.signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function writeHarnessArtifacts(input: {
  readonly artifactStore: AgentHarnessArtifactStore;
  readonly eventStream: CanonicalEventStream;
  readonly runId: string;
  readonly scopeId: string;
  readonly rootAgentId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly events: readonly CanonicalEvent[];
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly hookDecisions: readonly AgentLifecycleHookDecisionRecord[];
  readonly summary: JsonObject;
}): Promise<readonly AgentHarnessArtifactRef[]> {
  const artifacts: readonly ArtifactWriteSpec[] = [
    {
      id: "canonical-events",
      kind: "events",
      fileName: "canonical-events.json",
      description: "Canonical Generic AI harness events.",
      value: input.events,
    },
    {
      id: "harness-projections",
      kind: "trace",
      fileName: "harness-projections.json",
      description: "Typed harness event projections.",
      value: input.projections,
    },
    {
      id: "policy-decisions",
      kind: "policy",
      fileName: "policy-decisions.json",
      description: "Policy decisions recorded for this harness run.",
      value: input.policyDecisions,
    },
    {
      id: "hook-decisions",
      kind: "hook",
      fileName: "hook-decisions.json",
      description: "Agent lifecycle hook decisions recorded for this harness run.",
      value: input.hookDecisions,
    },
    {
      id: "harness-summary",
      kind: "summary",
      fileName: "summary.json",
      description: "Harness run summary.",
      value: input.summary,
    },
  ] as const;
  const refs: AgentHarnessArtifactRef[] = [];

  for (const artifact of artifacts) {
    const ref = await input.artifactStore.write({
      id: artifact.id,
      kind: artifact.kind,
      bytes: `${JSON.stringify(artifact.value, null, 2)}\n`,
      contentType: "application/json",
      description: artifact.description,
      ownerId: input.rootAgentId,
      namespace: "harness",
      metadata: jsonObject({
        fileName: artifact.fileName,
      }),
    });
    refs.push(ref);
    await input.eventStream.emit({
      runId: input.runId,
      scopeId: input.scopeId,
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
      name: "artifact.created",
      data: jsonObject({
        artifactId: ref.id,
        kind: ref.kind,
        uri: ref.uri,
        sha256: ref.sha256,
        localPath: ref.localPath,
      }),
    });
  }

  return Object.freeze(refs);
}

export function createAgentHarness<TCapabilities, TOutput>(
  config: AgentHarnessConfig,
  options: CreateAgentHarnessOptions<TCapabilities, TOutput> & {
    readonly adapters: AgentHarnessAdapterRegistry<TCapabilities, TOutput>;
  },
): AgentHarness<TCapabilities, TOutput>;
export function createAgentHarness(
  config: AgentHarnessConfig,
  options?: CreateAgentHarnessOptions,
): AgentHarness<PiCapabilityBindings, unknown>;
export function createAgentHarness<TCapabilities = PiCapabilityBindings, TOutput = unknown>(
  config: AgentHarnessConfig,
  options: CreateAgentHarnessOptions<TCapabilities, TOutput> = {},
): AgentHarness<TCapabilities, TOutput> {
  const sessionAdapterOptions: CreateAgentHarnessOptions = {
    ...(options.hookHandlers === undefined ? {} : { hookHandlers: options.hookHandlers }),
  };
  const adapters = {
    pi: createSessionAgentHarnessAdapter(
      config,
      sessionAdapterOptions,
      createPiSessionBackend(config, {
        ...(options.factories === undefined ? {} : { factories: options.factories }),
        ...(options.sessionInputs === undefined ? {} : { sessionInputs: options.sessionInputs }),
      }),
    ) as unknown as AgentHarnessAdapter<TCapabilities, TOutput>,
    native: createSessionAgentHarnessAdapter(
      config,
      sessionAdapterOptions,
      createNativeSessionBackend(config, options.native ?? {}),
    ) as unknown as AgentHarnessAdapter<TCapabilities, TOutput>,
    ...options.adapters,
  } as const;
  const adapterKind = config.adapter ?? "pi";
  const adapter = adapters[adapterKind];
  if (!adapter) {
    throw new Error(`Harness adapter "${adapterKind}" is not registered.`);
  }
  return Object.freeze({
    config,
    adapter,
    run(input: Omit<AgentHarnessRunInput<TCapabilities>, "harness">) {
      const runId = input.runId ?? randomUUID();
      const runInput: AgentHarnessRunInput<TCapabilities> = {
        ...input,
        runId,
        harness: config,
      };
      return adapter.run(runInput, createDefaultRunContext(runInput, options));
    },
  });
}

function createDefaultRunContext<TCapabilities>(
  input: AgentHarnessRunInput<TCapabilities>,
  options: { readonly policy?: AgentHarnessPolicyEvaluator } = {},
): AgentHarnessAdapterRunContext {
  const eventSink = createEventSink();
  return Object.freeze({
    ...(input.deadline === undefined ? {} : { deadline: new Date(input.deadline) }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    events: eventSink.sink,
    artifacts: createLocalArtifactStore({
      runId: input.runId ?? randomUUID(),
      artifactDir: resolve(
        input.artifactDir ??
          input.harness.artifactDir ??
          join(input.workspaceRoot, ".generic-ai", "artifacts", input.runId ?? "run"),
      ),
    }),
    policy:
      options.policy ??
      createPolicyEvaluator({
        runId: input.runId ?? "run",
        actorId: input.rootAgentId ?? input.harness.primaryAgent ?? "root",
      }),
  });
}

function failedHarnessResult(input: {
  readonly input: AgentHarnessRunInput<PiCapabilityBindings>;
  readonly runId: string;
  readonly statusMessage: string;
  readonly errorCategory: AgentHarnessRunErrorCategory;
}): AgentHarnessRunResult<unknown> {
  const now = new Date().toISOString();
  return Object.freeze({
    harnessId: input.input.harness.id,
    adapter: input.input.harness.adapter ?? "pi",
    status: "failed" as const,
    outputText: "",
    envelope: {
      kind: "run-envelope" as const,
      runId: input.runId,
      rootScopeId: input.input.rootScopeId ?? "scope/root",
      rootAgentId: input.input.rootAgentId ?? input.input.harness.primaryAgent ?? "root",
      mode: "sync" as const,
      status: "failed" as const,
      timestamps: {
        createdAt: now,
        startedAt: now,
        completedAt: now,
      },
      eventStream: {
        kind: "event-stream-reference" as const,
        streamId: input.runId,
      },
    },
    events: Object.freeze([]),
    projections: Object.freeze([]),
    artifacts: Object.freeze([]),
    policyDecisions: Object.freeze([]),
    hookDecisions: Object.freeze([]),
    failureMessage: input.statusMessage,
    errorCategory: input.errorCategory,
  });
}

function createSessionAgentHarnessAdapter(
  config: AgentHarnessConfig,
  options: Pick<CreateAgentHarnessOptions, "hookHandlers">,
  backend: HarnessSessionBackend,
): AgentHarnessAdapter<PiCapabilityBindings, unknown> {
  return Object.freeze({
    id: `${config.id}:${backend.kind}`,
    kind: backend.kind,
    async run(
      input: AgentHarnessRunInput<PiCapabilityBindings>,
      context: AgentHarnessAdapterRunContext,
    ): Promise<AgentHarnessRunResult<unknown>> {
      const adapterKind = input.harness.adapter ?? "pi";
      if (adapterKind !== backend.kind) {
        throw new Error(
          `Harness adapter "${adapterKind}" is configured, but this adapter runs "${backend.kind}".`,
        );
      }

      const runId = input.runId ?? randomUUID();
      const rootScopeId = input.rootScopeId ?? "scope/root";
      const rootAgentId = input.rootAgentId ?? input.harness.primaryAgent ?? "root";
      const profile = input.harness.policyProfile ?? LOCAL_DEV_FULL_POLICY_PROFILE;
      const allowMcp = input.harness.allowMcp ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
      const allowNetwork = input.harness.allowNetwork ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
      const turnMode = input.harness.execution?.turnMode;
      const maxTurns = input.harness.execution?.maxTurns;
      if (context.signal?.aborted) {
        return failedHarnessResult({
          input,
          runId,
          statusMessage: `Harness run was cancelled before the ${backend.label} adapter started.`,
          errorCategory: "cancelled",
        });
      }
      if (context.deadline !== undefined && Date.now() >= context.deadline.getTime()) {
        return failedHarnessResult({
          input,
          runId,
          statusMessage: `Harness run deadline elapsed before the ${backend.label} adapter started.`,
          errorCategory: "deadline_exceeded",
        });
      }
      const secrets = input.capabilities?.secrets;
      await secrets?.prepare();
      const eventStream = createCanonicalEventStream({
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(secrets === undefined ? {} : { redactData: (data) => secrets.redact(data) }),
      });
      const budget = context.budget ?? input.budget;
      const usageMeter = createUsageMeter({
        eventStream,
        ...(budget === undefined ? {} : { budget: usageBudgetLimits(budget) }),
      });
      const runSignal = createDeadlineSignal({
        signal: withUsageSignal(context.signal, usageMeter),
        ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      });
      const hookExecutor = createAgentLifecycleHookExecutor(input.hooks ?? input.harness.hooks, {
        eventStream,
        ...(options.hookHandlers === undefined ? {} : { inProcessHandlers: options.hookHandlers }),
      });
      const roles = resolveRoles(input.harness);
      const baseCapabilities = await expandMcpCapabilityTools(
        applyProfilePolicy(input.capabilities ?? {}, profile, allowMcp),
      );
      const deniedEffects = profileDeniedEffects({ profile, allowNetwork, allowMcp });
      const profilePolicyDecisions = createPolicyDecisions({
        runId,
        actorId: rootAgentId,
        profile,
        allowNetwork,
        allowMcp,
      });
      const policyDecisions: PolicyDecisionRecord[] = [...profilePolicyDecisions];
      let rootRuntimeSessionId: string | undefined;
      const rootHookContext = {
        runId,
        scopeId: rootScopeId,
        actorId: rootAgentId,
        roleId: rootAgentId,
      };
      const rootPolicyResult = await applyRolePolicy({
        capabilities: {
          ...baseCapabilities,
          customTools: [
            ...(baseCapabilities.customTools ?? []),
            createDelegateTool({
              runId,
              rootScopeId,
              rootAgentId,
              workspaceRoot: input.workspaceRoot,
              instruction: input.instruction,
              ...(turnMode === undefined ? {} : { turnMode }),
              ...(maxTurns === undefined ? {} : { maxTurns }),
              roles,
              capabilities: baseCapabilities,
              deniedEffects,
              hookExecutor,
              policy: context.policy,
              ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
              eventStream,
              getRootSessionId: () => rootRuntimeSessionId,
              recordPolicyDecisions: (decisions) => {
                policyDecisions.push(...decisions);
              },
              backend,
              usageMeter,
            }),
          ],
        },
        rolePolicy: "coordinator",
        runId,
        actorId: rootAgentId,
        deniedEffects,
        policy: context.policy,
      });
      policyDecisions.push(...rootPolicyResult.policyDecisions);
      const rootRole = roles.find((role) => role.id === rootAgentId);
      const rootGrants = rootRole?.secrets ?? input.harness.secrets;
      const rootSecretsCapabilities = wrapCapabilitiesWithSecrets({
        capabilities: rootPolicyResult.capabilities,
        secrets,
        actorId: rootAgentId,
        grants: rootGrants,
        runId,
        onAccess: async (record) => {
          const decision = secretAccessPolicyDecision(record);
          policyDecisions.push(decision);
          const sessionId = rootRuntimeSessionId ?? runId;
          await emitPolicyDecision(eventStream, {
            runId,
            scopeId: rootScopeId,
            rootSessionId: sessionId,
            sessionId,
            decision,
          });
        },
      });
      const rootSecretsGuidance = await secretsPromptGuidance(secrets, rootGrants);
      const rootCapabilities = wrapCapabilitiesWithHooks({
        capabilities: rootSecretsCapabilities,
        executor: hookExecutor,
        context: rootHookContext,
      });
      const rootLifecycleHooks = createSessionLifecycleHooks({
        executor: hookExecutor,
        context: rootHookContext,
      });

      const result = await backend
        .run({
          cwd: input.workspaceRoot,
          ...(rootRole === undefined ? {} : { role: rootRole }),
          capabilities: rootCapabilities,
          prompt: `${buildRootPrompt({
            instruction: input.instruction,
            roles,
            policyProfile: profile,
            ...(turnMode === undefined ? {} : { turnMode }),
          })}${rootSecretsGuidance}`,
          ...(turnMode === undefined ? {} : { turnMode }),
          ...(maxTurns === undefined ? {} : { maxTurns }),
          runId,
          rootScopeId,
          rootAgentId,
          ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
          eventStream,
          usageMeter,
          ...(rootLifecycleHooks === undefined ? {} : { lifecycleHooks: rootLifecycleHooks }),
          onSessionReady: async (context) => {
            rootRuntimeSessionId = context.sessionId;
            await observePermissionDecisions({
              executor: hookExecutor,
              context: rootHookContext,
              decisions: policyDecisions,
              sessionContext: context,
            });
            for (const decision of policyDecisions) {
              await emitPolicyDecision(eventStream, {
                runId,
                scopeId: rootScopeId,
                rootSessionId: context.rootSessionId,
                sessionId: context.sessionId,
                decision,
              });
            }
          },
        })
        .finally(() => {
          runSignal.cleanup();
        });
      const outputText =
        secrets === undefined ? result.outputText : secrets.redactText(result.outputText);
      const events = result.events;
      const projections = Object.freeze(events.map(projectEvent));
      const budgetStop = usageMeter.exceeded;
      const failureMessage = budgetStop?.message ?? result.failureMessage;
      const status = failureMessage === undefined ? "succeeded" : "failed";
      const usage = usageMeter.summary();
      const finalPolicyDecisions = Object.freeze([...policyDecisions]);
      const hookDecisions = hookExecutor.snapshot();
      const summary = jsonObject({
        harnessId: input.harness.id,
        adapter: backend.kind,
        status,
        outputText,
        eventCount: events.length,
        projectionCount: projections.length,
        policyDecisionCount: finalPolicyDecisions.length,
        hookDecisionCount: hookDecisions.length,
        ...(usage.totals.responses === 0
          ? {}
          : { totalTokens: usage.totals.totalTokens, costUsd: usage.totals.costUsd }),
      });
      const artifacts = await writeHarnessArtifacts({
        artifactStore: context.artifacts,
        eventStream,
        runId,
        scopeId: rootScopeId,
        rootAgentId,
        rootSessionId: result.sessionId,
        sessionId: result.sessionId,
        events,
        projections,
        policyDecisions: finalPolicyDecisions,
        hookDecisions,
        summary,
      });
      const finalEvents = eventStream.snapshot();
      const finalProjections = Object.freeze(finalEvents.map(projectEvent));
      for (const projection of finalProjections) {
        await context.events.emit(projection);
      }

      return Object.freeze({
        harnessId: input.harness.id,
        adapter: backend.kind,
        status,
        outputText,
        envelope: result.envelope,
        events: finalEvents,
        projections: finalProjections,
        artifacts,
        policyDecisions: finalPolicyDecisions,
        hookDecisions,
        ...(usage.totals.responses === 0 ? {} : { usage }),
        ...(failureMessage === undefined ? {} : { failureMessage }),
        ...(budgetStop === undefined ? {} : { errorCategory: "budget_exceeded" as const }),
      });
    },
  });
}

/** The caller's signal combined with the meter's, so a reached cap stops the run like a cancel. */
function withUsageSignal(signal: AbortSignal | undefined, meter: UsageMeter): AbortSignal {
  return signal === undefined ? meter.signal : AbortSignal.any([signal, meter.signal]);
}

/** The token and dollar caps of a harness budget; tool-call and wall-time caps are enforced elsewhere. */
function usageBudgetLimits(budget: AgentHarnessBudget): UsageBudgetLimits {
  return {
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
  };
}

export async function runAgentHarness(
  options: RunAgentHarnessOptions,
): Promise<AgentHarnessRunResult<unknown>> {
  const harness = createAgentHarness(
    options.harness,
    options.factories === undefined ? {} : { factories: options.factories },
  );
  return harness.run(options);
}

export interface RunAgentHarnessTopologyOptions
  extends Omit<RunHarnessTopologyOptions, "runner" | "deadline"> {
  readonly harness: AgentHarnessConfig;
  readonly workspaceRoot: string;
  readonly capabilities?: PiCapabilityBindings;
  readonly hooks?: AgentHarnessRunInput["hooks"];
  readonly artifactDir?: string;
  readonly rootScopeId?: string;
  readonly deadline?: string;
  readonly factories?: PiRuntimeFactories;
  readonly sessionInputs?: PiSessionInputs;
  /** Options for the native runtime, used when `harness.adapter` is `"native"`. */
  readonly native?: NativeAgentHarnessOptions;
  readonly hookHandlers?: readonly AgentLifecycleInProcessHookHandler[];
  readonly policy?: AgentHarnessPolicyEvaluator;
  /** Redaction-safe identity of whoever started the run; stamped on every run event. */
  readonly actor?: RunActor;
  /**
   * Token and dollar caps for the whole topology run, shared by every actor session. When a cap is
   * reached the running sessions stop, the run fails with `budget_exceeded`, and no new actions start.
   */
  readonly budget?: AgentHarnessBudget;
  /**
   * Replace the role-session runner, for example to route some actors to an
   * external runtime. The replacement still gets the scheduler's retries,
   * concurrency, budgets, and trace.
   */
  readonly runner?: TopologyActorRunner;
}

export interface AgentHarnessTopologyRunResult extends HarnessTopologyRunResult {
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly hookDecisions: readonly AgentLifecycleHookDecisionRecord[];
  /** Model usage of every actor session, when the backend meters it (native does). */
  readonly usage?: UsageSummary;
}

/**
 * Run a compiled harness's protocol topology (pipeline, verifier-loop,
 * hierarchy, squad, or a custom protocol) with each actor executed as a
 * policy-scoped role session on the harness's backend (pi or native).
 *
 * Shares the agent harness's policy profile, role effect policies, lifecycle
 * hooks, canonical event stream, and artifact layout, and adds the topology
 * trace and per-action outcomes as artifacts.
 */
export async function runAgentHarnessTopology(
  options: RunAgentHarnessTopologyOptions,
): Promise<AgentHarnessTopologyRunResult> {
  const runId = options.runId ?? randomUUID();
  const rootScopeId = options.rootScopeId ?? "scope/root";
  const harness = options.harness;
  const profile = harness.policyProfile ?? LOCAL_DEV_FULL_POLICY_PROFILE;
  const allowMcp = harness.allowMcp ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
  const allowNetwork = harness.allowNetwork ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
  const turnMode = harness.execution?.turnMode;
  const maxTurns = harness.execution?.maxTurns;
  const topologySessionId = `${runId}:topology`;
  const eventStream = createCanonicalEventStream(
    options.actor === undefined ? {} : { actor: options.actor },
  );
  const hookExecutor = createAgentLifecycleHookExecutor(options.hooks ?? harness.hooks, {
    eventStream,
    ...(options.hookHandlers === undefined ? {} : { inProcessHandlers: options.hookHandlers }),
  });
  const policy =
    options.policy ?? createPolicyEvaluator({ runId, actorId: harness.primaryAgent ?? "topology" });
  const baseCapabilities = applyProfilePolicy(options.capabilities ?? {}, profile, allowMcp);
  const deniedEffects = profileDeniedEffects({ profile, allowNetwork, allowMcp });
  const policyDecisions: PolicyDecisionRecord[] = [
    ...createPolicyDecisions({
      runId,
      actorId: harness.primaryAgent ?? "topology",
      profile,
      allowNetwork,
      allowMcp,
    }),
  ];
  const artifactStore = createLocalArtifactStore({
    runId,
    artifactDir: resolve(
      options.artifactDir ??
        harness.artifactDir ??
        join(options.workspaceRoot, ".generic-ai", "artifacts", runId),
    ),
  });
  const usageMeter = createUsageMeter({
    eventStream,
    ...(options.budget === undefined ? {} : { budget: usageBudgetLimits(options.budget) }),
  });
  const goalId = options.goal?.spec.id;
  if (goalId !== undefined) {
    // Every actor's spend counts toward the goal, so the result reports tokens per completed goal.
    usageMeter.ledger.assignRunToGoal(runId, goalId);
  }
  const runSignal = createDeadlineSignal({
    signal: withUsageSignal(options.signal, usageMeter),
    ...(options.deadline === undefined ? {} : { deadline: new Date(options.deadline) }),
  });
  const backend =
    harness.adapter === "native"
      ? createNativeSessionBackend(harness, options.native ?? {})
      : createPiSessionBackend(harness, {
          ...(options.factories === undefined ? {} : { factories: options.factories }),
          ...(options.sessionInputs === undefined ? {} : { sessionInputs: options.sessionInputs }),
        });
  const eventContext = {
    runId,
    scopeId: rootScopeId,
    rootSessionId: topologySessionId,
    sessionId: topologySessionId,
  };
  for (const decision of policyDecisions) {
    await emitPolicyDecision(eventStream, { ...eventContext, decision });
  }

  const roleRunner: TopologyActorRunner = async (
    invocation: TopologyActorInvocation,
  ): Promise<TopologyActorResult> => {
    const role = resolveTopologyActorRole(invocation.actor, harness.roles);
    const delegationId = `${runId}:topology:${invocation.action.id}:${invocation.attempt}`;
    const handoffContext = { ...eventContext, delegationId };
    await eventStream.emit({
      ...handoffContext,
      name: "handoff.requested",
      data: {
        roleId: role.id,
        protocol: invocation.protocol,
        actionId: invocation.action.id,
        actionKind: invocation.action.kind,
        attempt: invocation.attempt,
        task: invocation.task,
      },
    });
    await eventStream.emit({
      ...handoffContext,
      name: "handoff.accepted",
      data: { roleId: role.id },
    });
    const delegatedTask = [
      invocation.task,
      ...(invocation.goalBrief === undefined ? [] : ["", invocation.goalBrief]),
      ...(invocation.context.length > 0
        ? ["", "Context from other agents:", invocation.context]
        : []),
    ].join("\n");
    let roleResult: RoleSessionResult;
    try {
      roleResult = await runRoleSession({
        runId,
        rootScopeId,
        workspaceRoot: options.workspaceRoot,
        backend,
        role,
        prompt: buildRolePrompt({
          role,
          instruction: delegatedTask,
          parentTask: invocation.instruction,
          ...(turnMode === undefined ? {} : { turnMode }),
        }),
        ...(turnMode === undefined ? {} : { turnMode }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        capabilities: baseCapabilities,
        deniedEffects,
        hookExecutor,
        policy,
        ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
        eventStream,
        rootSessionId: topologySessionId,
        parentSessionId: topologySessionId,
        recordPolicyDecisions: (decisions) => {
          policyDecisions.push(...decisions);
        },
        usageMeter,
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      await eventStream.emit({
        ...handoffContext,
        name: "handoff.failed",
        data: { roleId: role.id, status: "failed", failureMessage },
      });
      throw error;
    }
    const status = roleResult.failureMessage === undefined ? "succeeded" : "failed";
    await eventStream.emit({
      ...handoffContext,
      name: status === "succeeded" ? "handoff.completed" : "handoff.failed",
      data: {
        roleId: role.id,
        status,
        outputText: roleResult.outputText,
        ...(roleResult.failureMessage === undefined
          ? {}
          : { failureMessage: roleResult.failureMessage }),
      },
    });
    const sessionUsage = usageMeter
      .summary()
      .byAgent.find((entry) => entry.runId === runId && entry.agentId === roleResult.sessionId);
    return {
      status,
      outputText: roleResult.outputText,
      ...(roleResult.failureMessage === undefined
        ? {}
        : { failureMessage: roleResult.failureMessage }),
      ...(sessionUsage === undefined || sessionUsage.totals.responses === 0
        ? {}
        : { costUsd: sessionUsage.totals.costUsd }),
    };
  };

  const rest = options;
  const topologyResult = await runHarnessTopology({
    compiled: rest.compiled,
    instruction: rest.instruction,
    runId,
    runner: options.runner ?? roleRunner,
    ...(rest.protocol === undefined ? {} : { protocol: rest.protocol }),
    ...(rest.protocols === undefined ? {} : { protocols: rest.protocols }),
    ...(rest.maxSteps === undefined ? {} : { maxSteps: rest.maxSteps }),
    ...(rest.maxConcurrency === undefined ? {} : { maxConcurrency: rest.maxConcurrency }),
    ...(rest.maxAttempts === undefined ? {} : { maxAttempts: rest.maxAttempts }),
    ...(rest.deadline === undefined ? {} : { deadline: rest.deadline }),
    ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
    ...(rest.approve === undefined ? {} : { approve: rest.approve }),
    ...(rest.onTraceEvent === undefined ? {} : { onTraceEvent: rest.onTraceEvent }),
    ...(rest.onOutcome === undefined ? {} : { onOutcome: rest.onOutcome }),
    ...(rest.resumeFrom === undefined ? {} : { resumeFrom: rest.resumeFrom }),
    ...(rest.goal === undefined ? {} : { goal: rest.goal }),
    ...(rest.goalValidators === undefined ? {} : { goalValidators: rest.goalValidators }),
    collectGoalEvidence: async (evidenceInput) => {
      const custom = await rest.collectGoalEvidence?.(evidenceInput);
      return {
        trace: goalTraceFromCanonicalEvents(eventStream.snapshot()),
        ...(custom ?? {}),
      };
    },
  }).finally(() => {
    runSignal.cleanup();
  });
  const budgetStop = usageMeter.exceeded;
  if (goalId !== undefined) {
    usageMeter.ledger.setGoalOutcome(
      goalId,
      budgetStop !== undefined
        ? "failed"
        : topologyResult.status === "succeeded"
          ? "completed"
          : topologyResult.status === "cancelled"
            ? "cancelled"
            : "failed",
    );
  }
  const usage = usageMeter.summary();
  const topology: HarnessTopologyRunResult =
    budgetStop === undefined
      ? topologyResult
      : {
          ...topologyResult,
          status: "failed",
          failureMessage: budgetStop.message,
          errorCategory: "budget_exceeded",
        };

  policyDecisions.push(...topology.policyDecisions);
  const finalPolicyDecisions = Object.freeze([...policyDecisions]);
  const hookDecisions = hookExecutor.snapshot();
  const preArtifactEvents = eventStream.snapshot();
  const topologyArtifacts: AgentHarnessArtifactRef[] = [];
  for (const artifact of [
    {
      id: "topology-trace",
      kind: "trace" as const,
      description: "Topology runner trace events.",
      value: topology.trace,
    },
    {
      id: "topology-outcomes",
      kind: "report" as const,
      description: "Outcome of every protocol action the topology runner executed.",
      value: topology.outcomes,
    },
  ]) {
    topologyArtifacts.push(
      await artifactStore.write({
        id: artifact.id,
        kind: artifact.kind,
        bytes: `${JSON.stringify(artifact.value, null, 2)}\n`,
        contentType: "application/json",
        description: artifact.description,
        ownerId: topology.protocol,
        namespace: "topology",
      }),
    );
  }
  const harnessArtifacts = await writeHarnessArtifacts({
    artifactStore,
    eventStream,
    runId,
    scopeId: rootScopeId,
    rootAgentId: harness.primaryAgent ?? "topology",
    rootSessionId: topologySessionId,
    sessionId: topologySessionId,
    events: preArtifactEvents,
    projections: Object.freeze(preArtifactEvents.map(projectEvent)),
    policyDecisions: finalPolicyDecisions,
    hookDecisions,
    summary: jsonObject({
      harnessId: harness.id,
      compiledHarnessId: topology.harnessId,
      adapter: "pi",
      mode: "topology",
      protocol: topology.protocol,
      bindingId: topology.bindingId ?? null,
      status: topology.status,
      outputText: topology.outputText,
      steps: topology.steps,
      actionCount: topology.outcomes.length,
      failureMessage: topology.failureMessage ?? null,
      notes: [...topology.notes],
    }),
  });
  const finalEvents = eventStream.snapshot();

  return Object.freeze({
    ...topology,
    events: Object.freeze([...finalEvents, ...topology.events]),
    projections: Object.freeze(finalEvents.map(projectEvent)),
    policyDecisions: finalPolicyDecisions,
    hookDecisions,
    artifacts: Object.freeze([...topology.artifacts, ...topologyArtifacts, ...harnessArtifacts]),
    ...(usage.totals.responses === 0 ? {} : { usage }),
  });
}
