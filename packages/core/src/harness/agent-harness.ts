import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RequestAuth, StreamFn } from "@generic-ai/agent";
import {
  createFallbackModel,
  type Model,
  type RetryPolicy,
  registerVirtualModel,
  resolveApiKey,
  type ThinkingLevel,
} from "@generic-ai/ai";
import type { PromptTemplate } from "@generic-ai/resources";
import {
  type AgentHarness,
  type AgentHarnessAdapter,
  type AgentHarnessAdapterKind,
  type AgentHarnessAdapterRunContext,
  type AgentHarnessArtifactRef,
  type AgentHarnessArtifactStore,
  type AgentHarnessArtifactWriteInput,
  type AgentHarnessBudget,
  type AgentHarnessCapabilityEffect,
  type AgentHarnessConfig,
  type AgentHarnessEventProjection,
  type AgentHarnessEventSink,
  type AgentHarnessEventType,
  type AgentHarnessHostTool,
  type AgentHarnessPolicyEvaluationInput,
  type AgentHarnessPolicyEvaluator,
  type AgentHarnessPolicyProfileId,
  type AgentHarnessRole,
  type AgentHarnessRunErrorCategory,
  type AgentHarnessRunInput,
  type AgentHarnessRunResult,
  type AgentHarnessSteering,
  type AgentLifecycleHookContext,
  type AgentLifecycleHookDecisionRecord,
  type AgentLifecycleInProcessHookHandler,
  type CanonicalEvent,
  createToolEffectGuard,
  DEFAULT_AGENT_HARNESS_ADAPTER,
  defineTool,
  getAgentHarnessToolEffects,
  type JsonObject,
  type PolicyDecisionRecord,
  type ResourceSelector,
  type RunEnvelope,
  type ToolDefinition,
  type ToolEffectGuard,
  type UsageBudgetLimits,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import {
  type CompactionSettings,
  SessionManager as NativeSessionManager,
} from "@generic-ai/session";
import { getAgentCommandEnv } from "@generic-ai/tools";
import { Type } from "@sinclair/typebox";

import { type CanonicalEventStream, createCanonicalEventStream } from "../events/index.js";
import {
  type CapabilityPiSessionEventContext,
  expandMcpCapabilityTools,
  type PiCapabilityBindings,
  type PiCapabilitySessionLifecycleHooks,
} from "../runtime/capability-runtime.js";
import { DEFAULT_NATIVE_MODEL, resolveNativeModel } from "../runtime/native.js";
import type { NativeSessionSchedules } from "../runtime/native-schedules.js";
import {
  expandPrompt,
  type NativeSessionAutonomous,
  type NativeSessionExtensions,
  type NativeSessionGoal,
  type NativeSessionRlm,
  type NativeSessionSubagents,
  type RunCapabilityNativeAgentSessionOptions,
  runCapabilityNativeAgentSession,
} from "../runtime/native-session.js";
import { createUsageMeter, type UsageMeter } from "../usage/index.js";
import {
  type AgentLifecycleHookExecutor,
  appendHookContext,
  createAgentLifecycleHookExecutor,
  wrapToolWithLifecycleHooks,
} from "./lifecycle-hooks.js";
import {
  secretAccessPolicyDecision,
  secretsPromptGuidance,
  wrapCapabilitiesWithSecrets,
} from "./secrets.js";

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
  /**
   * Request auth per request from a credential store, tried before `apiKey` (for example
   * `createModelAuthResolver` from `@generic-ai/auth`, which handles the Claude, ChatGPT and GitHub
   * Copilot subscription sign-ins).
   */
  readonly getAuth?: (provider: string) => Promise<RequestAuth | undefined>;
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Backup model references, tried in order when a role's model fails before producing output
   * (an outage, overload or exhausted quota). Each backup resolves its own credentials.
   */
  readonly fallbackModels?: readonly string[];
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
  /**
   * Extensions loaded into every native session (see `@generic-ai/extensions`). Each session gets
   * its own instances. Extension tools are added as given: role effect policies do not filter them.
   */
  readonly extensions?: NativeSessionExtensions;
  /**
   * Let every native session spawn subagents and message them (see `@generic-ai/subagents`).
   * A spawn's `model` goes through `resolveModel`; children get the session's tools.
   */
  readonly subagents?: Omit<NativeSessionSubagents, "resolveModel" | "getApiKey"> | boolean;
  /**
   * Give every native session a persistent Python workspace, the `python` tool (see
   * `@generic-ai/rlm`). `model` names the default sub-model for `rlm.llm` (`"provider/id"`, a
   * small one is cheaper); without it sub-calls use the session's model. Code may name any model
   * the harness can resolve. Needs Python 3 on the host.
   */
  readonly rlm?:
    | (Omit<NativeSessionRlm, "model" | "resolveModel" | "getApiKey"> & {
        readonly model?: string;
        /**
         * Extra environment for the kernel of the agent a run is for (its root agent id), added
         * to `env` or, without it, to the agent-command allowlist. For example per-agent proxy
         * settings.
         */
        readonly agentEnv?: (agentId: string) => Readonly<Record<string, string>>;
      })
    | boolean;
  /**
   * Give every native session the thread-goal tools (see `@generic-ai/autonomy`). A session keeps
   * working while a goal the agent created is active. A topology run's own goal is not handed to
   * each actor: it is the team's goal, and the topology runner checks it with the same SDK runner.
   */
  readonly goal?:
    | Omit<NativeSessionGoal, "spec" | "validation" | "collectEvidence" | "objective">
    | boolean;
  /**
   * Run every native session in autonomous mode: it continues until the quality gates pass or a
   * limit is reached. Gate commands run in the clean agent-command environment.
   */
  readonly autonomous?: NativeSessionAutonomous | boolean;
  /**
   * Give every native session the schedule and heartbeat tools. With a `service` and a
   * `sessionDir`, jobs that come due after a run resume its session from the durable queue.
   */
  readonly schedules?: NativeSessionSchedules | boolean;
  /** Offload long tool results to files (on by default; `false` turns it off). */
  readonly offload?: RunCapabilityNativeAgentSessionOptions["offload"];
  /** Give every native session `tool_batch`. */
  readonly toolBatch?: RunCapabilityNativeAgentSessionOptions["toolBatch"];
  /** Defer MCP tools behind `tool_search` (see `RunCapabilityNativeAgentSessionOptions.toolSearch`). */
  readonly toolSearch?: RunCapabilityNativeAgentSessionOptions["toolSearch"];
  /** Save the scripts a session wrote when its run passes its goal's validators. */
  readonly harvest?: RunCapabilityNativeAgentSessionOptions["harvest"];
  /** The continual harness for every native session (see `docs/continual-harness.md`). */
  readonly continual?: RunCapabilityNativeAgentSessionOptions["continual"];
  /** Project instruction files (`AGENTS.md` and friends) in every native session's system prompt. */
  readonly contextFiles?: RunCapabilityNativeAgentSessionOptions["contextFiles"];
}

export interface CreateAgentHarnessOptions<
  TCapabilities = PiCapabilityBindings,
  TOutput = unknown,
> {
  readonly native?: NativeAgentHarnessOptions;
  /**
   * Prompt templates (see `loadPromptTemplates` in `@generic-ai/resources`). A run instruction
   * that starts with `/name args` expands to template `name`. An instruction that starts with
   * `/skill:name args` expands to that skill from the `skills` capability.
   */
  readonly promptTemplates?: readonly PromptTemplate[];
  readonly hookHandlers?: readonly AgentLifecycleInProcessHookHandler[];
  readonly policy?: AgentHarnessPolicyEvaluator;
  readonly adapters?: AgentHarnessAdapterRegistry<TCapabilities, TOutput>;
}

export interface RunAgentHarnessOptions extends AgentHarnessRunInput<PiCapabilityBindings> {}

type AgentHarnessRolePolicy = "read-only" | "build";
type AgentHarnessTurnMode = NonNullable<NonNullable<AgentHarnessConfig["execution"]>["turnMode"]>;

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
  "read-only": {
    allow: effectSet(READ_EFFECTS),
    denyUnknown: true,
  },
  build: {
    allow: effectSet(ALL_LOCAL_EFFECTS),
    denyUnknown: true,
  },
});

/**
 * Roles a harness offers its primary agent when its config names none: none. The primary agent
 * is a full agent with every tool its policy profile allows, and delegates only to roles the
 * config declares. No fixed plan, explore, build or verify pattern is built in.
 */
export const DEFAULT_AGENT_HARNESS_ROLES: readonly AgentHarnessRole[] = Object.freeze([]);

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

function policyForRole(role: AgentHarnessRole): AgentHarnessRolePolicy {
  return role.readOnly === true ? "read-only" : "build";
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
    "You are the primary agent for a Generic AI agent harness run. You have every tool this run allows; do the work yourself.",
    "Keep concrete evidence from tools, and check your result from the final state before finishing.",
    `Policy profile: ${input.policyProfile}.`,
    stopToolRunInstruction(input.turnMode),
    ...(input.roles.length === 0
      ? []
      : [
          "",
          "Other agents you can hand work to with delegate_agent (roleId and task), when that helps:",
          roleDirectory(input.roles),
        ]),
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

/**
 * Turns runtime-neutral host tools (ADR 0062) into tools both the pi and native runtimes run, with
 * their declared effects so role policy treats them like any other tool.
 */
export function toHarnessToolDefinition(tool: AgentHarnessHostTool): ToolDefinition {
  return withAgentHarnessToolEffects(
    defineTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
      ...(tool.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: [...tool.promptGuidelines] }),
      parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
      async execute(toolCallId, params, signal) {
        const result = await tool.execute((params ?? {}) as JsonObject, {
          toolCallId,
          ...(signal === undefined ? {} : { signal }),
        });
        if (result.isError === true) {
          throw new Error(result.text);
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result.details ?? {},
        };
      },
    }),
    [...tool.effects],
  ) as ToolDefinition;
}

function withHostTools(
  capabilities: PiCapabilityBindings,
  hostTools: readonly AgentHarnessHostTool[] | undefined,
): PiCapabilityBindings {
  if (hostTools === undefined || hostTools.length === 0) {
    return capabilities;
  }
  return {
    ...capabilities,
    customTools: [...(capabilities.customTools ?? []), ...hostTools.map(toHarnessToolDefinition)],
  };
}

/**
 * Journals outward tool calls (ADR 0059) so a retried attempt of the same turn replays finished
 * calls instead of repeating them. Applied before role policy and hooks, so delegated role
 * sessions in the same run share the guard and its occurrence counts.
 */
export function guardCapabilityEffects(
  capabilities: PiCapabilityBindings,
  guard: ToolEffectGuard,
): PiCapabilityBindings {
  return {
    ...capabilities,
    ...(capabilities.terminalTools === undefined
      ? {}
      : { terminalTools: { tool: guard.wrap(capabilities.terminalTools.tool) } }),
    ...(capabilities.fileTools === undefined
      ? {}
      : { fileTools: { piTools: guard.wrapAll(capabilities.fileTools.piTools) } }),
    ...(capabilities.customTools === undefined
      ? {}
      : { customTools: guard.wrapAll(capabilities.customTools) }),
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
  /**
   * Native backend: the session file this turn reads and appends to, opened if it exists and
   * created if not. Each finished message is saved as it ends, so the file holds every completed
   * step. Takes precedence over the harness-wide `sessionDir`.
   */
  readonly sessionFile?: string;
  /** Native backend: messages for the agent while the turn runs (`AgentHarnessRunInput.steering`). */
  readonly steering?: AgentHarnessSteering;
  /**
   * Native backend: continue `sessionFile` from its last completed step instead of sending
   * `prompt` (see `RunCapabilityNativeAgentSessionOptions.resume`). Use it to re-run a turn that a
   * restart interrupted.
   */
  readonly resume?: boolean;
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

function createNativeSessionBackend(
  config: AgentHarnessConfig,
  options: NativeAgentHarnessOptions,
): HarnessSessionBackend {
  const modelsByRef = new Map<string, Model>();
  const modelForRef = (ref: string): Model => {
    let model = modelsByRef.get(ref);
    if (model === undefined) {
      model = (options.resolveModel ?? resolveNativeModel)(ref);
      modelsByRef.set(ref, model);
    }
    return model;
  };
  const fallbackRefs = options.fallbackModels ?? [];
  const withFallbacks = (model: Model): Model => {
    if (fallbackRefs.length === 0) return model;
    const ref = `fallback/${model.provider}/${model.id}`;
    let wrapped = modelsByRef.get(ref);
    if (wrapped === undefined) {
      wrapped = registerVirtualModel(
        createFallbackModel({
          provider: "fallback",
          id: `${model.provider}/${model.id}`,
          name: `${model.name} with fallbacks`,
          models: [model, ...fallbackRefs.map(modelForRef)],
        }),
      ).model;
      modelsByRef.set(ref, wrapped);
    }
    return wrapped;
  };
  const modelFor = (role: AgentHarnessRole | undefined): Model =>
    withFallbacks(modelForRef(role?.model ?? config.model ?? DEFAULT_NATIVE_MODEL));
  const apiKeyForProvider = (provider: string): string | undefined =>
    options.apiKey ?? resolveApiKey(provider) ?? readTrimmedEnv("GENERIC_AI_PROVIDER_API_KEY");
  const apiKeyFor = (model: Model): string | undefined => apiKeyForProvider(model.provider);
  const subagents: NativeSessionSubagents | undefined =
    options.subagents === undefined || options.subagents === false
      ? undefined
      : {
          ...(options.subagents === true ? {} : options.subagents),
          resolveModel: (ref) => {
            try {
              return modelForRef(ref);
            } catch {
              return undefined;
            }
          },
          getApiKey: apiKeyForProvider,
        };

  const rlmOption = options.rlm === true ? {} : options.rlm === false ? undefined : options.rlm;
  const resolveRef = (ref: string): Model | undefined => {
    try {
      return modelForRef(ref);
    } catch {
      return undefined;
    }
  };
  const rlmFor = (agentId: string | undefined): NativeSessionRlm | undefined => {
    if (rlmOption === undefined) return undefined;
    const { model: subModelRef, agentEnv, ...rest } = rlmOption;
    const subModel = subModelRef === undefined ? undefined : resolveRef(subModelRef);
    const extraEnv =
      agentEnv === undefined || agentId === undefined ? undefined : agentEnv(agentId);
    return {
      ...rest,
      ...(extraEnv === undefined
        ? {}
        : { env: { ...(rest.env ?? getAgentCommandEnv()), ...extraEnv } }),
      ...(subModel === undefined ? {} : { model: subModel }),
      resolveModel: resolveRef,
      getApiKey: apiKeyForProvider,
    };
  };

  return Object.freeze({
    kind: "native" as const,
    label: "native",
    async run(runOptions: HarnessSessionRunOptions): Promise<HarnessSessionRunResult> {
      const { role, usageMeter, sessionFile, resume, ...rest } = runOptions;
      const model = modelFor(role);
      const apiKey = apiKeyFor(model);
      const result = await runCapabilityNativeAgentSession({
        ...rest,
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.getAuth === undefined ? {} : { getAuth: options.getAuth }),
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(sessionFile !== undefined
          ? {
              sessionManager: NativeSessionManager.open(
                sessionFile,
                dirname(sessionFile),
                rest.cwd,
              ),
            }
          : options.sessionDir === undefined
            ? {}
            : { sessionManager: NativeSessionManager.create(rest.cwd, options.sessionDir) }),
        ...(resume === true ? { resume: true } : {}),
        ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(usageMeter === undefined
          ? {}
          : { usageMeter, usageAttribution: { roleId: role?.id ?? rest.rootAgentId } }),
        ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        ...(subagents === undefined ? {} : { subagents }),
        ...(rlmOption === undefined ? {} : { rlm: rlmFor(rest.rootAgentId) ?? true }),
        ...(options.goal === undefined ? {} : { goal: options.goal }),
        ...(options.autonomous === undefined ? {} : { autonomous: options.autonomous }),
        ...(options.schedules === undefined ? {} : { schedules: options.schedules }),
        ...(options.offload === undefined ? {} : { offload: options.offload }),
        ...(options.toolBatch === undefined ? {} : { toolBatch: options.toolBatch }),
        ...(options.toolSearch === undefined ? {} : { toolSearch: options.toolSearch }),
        ...(options.harvest === undefined ? {} : { harvest: options.harvest }),
        ...(options.continual === undefined ? {} : { continual: options.continual }),
        ...(options.contextFiles === undefined ? {} : { contextFiles: options.contextFiles }),
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
  const rolePolicy = policyForRole(role);
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
      description: "Hand a focused task to another agent role declared in this harness.",
      promptSnippet: "delegate focused work to another harness role",
      promptGuidelines: [
        "Use delegate_agent when planning, exploration, building, or verification should be isolated.",
        "Give the delegated role a concrete task and expected output artifact.",
      ],
      parameters: Type.Object({
        roleId: Type.String({
          description: "Id of the role to hand the task to, from the list in your instructions.",
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
    ...(options.promptTemplates === undefined ? {} : { promptTemplates: options.promptTemplates }),
  };
  const adapters = {
    native: createSessionAgentHarnessAdapter(
      config,
      sessionAdapterOptions,
      createNativeSessionBackend(config, options.native ?? {}),
    ) as unknown as AgentHarnessAdapter<TCapabilities, TOutput>,
    ...options.adapters,
  } as const;
  const adapterKind = config.adapter ?? DEFAULT_AGENT_HARNESS_ADAPTER;
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

export interface CreateAgentHarnessRunContextOptions {
  readonly runId: string;
  /** Directory for the run's artifacts. */
  readonly artifactDir: string;
  /** Actor recorded on default policy decisions. Defaults to `root`. */
  readonly actorId?: string;
  /** Policy evaluator. Defaults to the allow-all harness evaluator. */
  readonly policy?: AgentHarnessPolicyEvaluator;
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
}

/**
 * Builds the run context `createAgentHarness().run()` uses (local artifact
 * store, in-memory event sink, policy evaluator), for hosts that call an
 * adapter directly, such as a durable task executor that passes each turn's
 * abort signal through.
 */
export function createAgentHarnessRunContext(
  options: CreateAgentHarnessRunContextOptions,
): AgentHarnessAdapterRunContext {
  return Object.freeze({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    events: createEventSink().sink,
    artifacts: createLocalArtifactStore({
      runId: options.runId,
      artifactDir: resolve(options.artifactDir),
    }),
    policy:
      options.policy ??
      createPolicyEvaluator({ runId: options.runId, actorId: options.actorId ?? "root" }),
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
    adapter: input.input.harness.adapter ?? DEFAULT_AGENT_HARNESS_ADAPTER,
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

/**
 * Expand a run instruction that is a skill command (`/skill:name args`) or a prompt template
 * (`/name args`). Other instructions are returned unchanged.
 */
async function expandHarnessInstruction(
  instruction: string,
  capabilities: PiCapabilityBindings,
  templates: readonly PromptTemplate[] | undefined,
): Promise<string> {
  if (!instruction.startsWith("/")) {
    return instruction;
  }
  const skills = instruction.startsWith("/skill:")
    ? ((await capabilities.skills?.load())?.skills ?? [])
    : [];
  return expandPrompt(instruction, skills, templates ?? []);
}

function createSessionAgentHarnessAdapter(
  config: AgentHarnessConfig,
  options: Pick<CreateAgentHarnessOptions, "hookHandlers" | "promptTemplates">,
  backend: HarnessSessionBackend,
): AgentHarnessAdapter<PiCapabilityBindings, unknown> {
  return Object.freeze({
    id: `${config.id}:${backend.kind}`,
    kind: backend.kind,
    async run(
      input: AgentHarnessRunInput<PiCapabilityBindings>,
      context: AgentHarnessAdapterRunContext,
    ): Promise<AgentHarnessRunResult<unknown>> {
      const adapterKind = input.harness.adapter ?? DEFAULT_AGENT_HARNESS_ADAPTER;
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
      const expandedCapabilities = withHostTools(
        await expandMcpCapabilityTools(
          applyProfilePolicy(input.capabilities ?? {}, profile, allowMcp),
        ),
        input.hostTools,
      );
      const baseCapabilities =
        input.effectJournal === undefined
          ? expandedCapabilities
          : guardCapabilityEffects(
              expandedCapabilities,
              createToolEffectGuard(input.effectJournal),
            );
      const instruction = await expandHarnessInstruction(
        input.instruction,
        baseCapabilities,
        options.promptTemplates,
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
      const rootRole = roles.find((role) => role.id === rootAgentId);
      // The primary agent is a full agent under its own role's policy (read-only only when its
      // role says so); it delegates when the config declares other roles.
      const rootRolePolicy: AgentHarnessRolePolicy =
        rootRole === undefined ? "build" : policyForRole(rootRole);
      const delegateRoles = roles.filter((role) => role.id !== rootAgentId);
      const rootPolicyResult = await applyRolePolicy({
        capabilities: {
          ...baseCapabilities,
          customTools: [
            ...(baseCapabilities.customTools ?? []),
            ...(delegateRoles.length === 0
              ? []
              : [
                  createDelegateTool({
                    runId,
                    rootScopeId,
                    rootAgentId,
                    workspaceRoot: input.workspaceRoot,
                    instruction,
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
                ]),
          ],
        },
        rolePolicy: rootRolePolicy,
        runId,
        actorId: rootAgentId,
        deniedEffects,
        policy: context.policy,
      });
      policyDecisions.push(...rootPolicyResult.policyDecisions);
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
            instruction,
            roles: delegateRoles,
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
          ...(input.session === undefined
            ? {}
            : {
                sessionFile: input.session.file,
                ...(input.session.resume === true ? { resume: true } : {}),
              }),
          ...(input.steering === undefined ? {} : { steering: input.steering }),
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
  const harness = createAgentHarness(options.harness);
  return harness.run(options);
}
