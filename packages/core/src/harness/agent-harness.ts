import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  defineTool,
  type AgentHarness,
  type AgentHarnessAdapter,
  type AgentHarnessAdapterRunContext,
  type AgentHarnessArtifactRef,
  type AgentHarnessArtifactStore,
  type AgentHarnessArtifactWriteInput,
  type AgentHarnessCapabilityEffect,
  type AgentHarnessConfig,
  type AgentHarnessEventSink,
  type AgentHarnessEventProjection,
  type AgentHarnessEventType,
  type AgentHarnessPolicyEvaluationInput,
  type AgentHarnessPolicyEvaluator,
  type AgentHarnessPolicyProfileId,
  type AgentHarnessRole,
  type AgentHarnessRunInput,
  type AgentHarnessRunErrorCategory,
  type AgentHarnessRunResult,
  type CanonicalEvent,
  getAgentHarnessToolEffects,
  type JsonObject,
  type PolicyDecisionRecord,
  type ResourceSelector,
  type ToolDefinition,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createCanonicalEventStream, type CanonicalEventStream } from "../events/index.js";
import {
  type CapabilityPiSessionEventContext,
  type PiCapabilityBindings,
  runCapabilityPiAgentSession,
} from "../runtime/capability-runtime.js";
import type { PiRuntimeFactories } from "../runtime/pi.js";
import { DEFAULT_OPENAI_CODEX_MODEL } from "../runtime/types.js";

export interface CreateAgentHarnessOptions {
  readonly factories?: PiRuntimeFactories;
  readonly sessionInputs?: PiSessionInputs;
  readonly policy?: AgentHarnessPolicyEvaluator;
}

export interface RunAgentHarnessOptions extends AgentHarnessRunInput<PiCapabilityBindings> {
  readonly factories?: PiRuntimeFactories;
}

type AgentHarnessRolePolicy = "coordinator" | "read-only" | "build" | "verify";
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
  "mcp.launch",
  "memory.write",
  "secret.read",
  "sandbox.create",
]);

const OPENAI_CODEX_PI_PROVIDER = "openai-codex";

const ALL_LOCAL_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  ...READ_EFFECTS,
  ...HANDOFF_EFFECTS,
  ...MUTATING_EFFECTS,
  "mcp.read",
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

function buildRootPrompt(input: {
  readonly instruction: string;
  readonly roles: readonly AgentHarnessRole[];
  readonly policyProfile: AgentHarnessPolicyProfileId;
}): string {
  return [
    "You are the root coordinator for a Generic AI composable agent harness run.",
    "Use model-directed Plan/Explore/Build/Verify topology. Delegate whenever another role should do focused work.",
    "Planner and explorer roles are read-only. Builder may edit and run terminal commands. Verifier may run terminal checks but must not use file write/edit tools.",
    "Before finishing, delegate a verifier pass that reruns the important command from the final state instead of trusting stale builder logs.",
    "Keep durable handoffs in the delegation messages and preserve concrete evidence from tools.",
    `Policy profile: ${input.policyProfile}.`,
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
  };
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
    effects.add("mcp.launch");
    effects.add("secret.read");
  }
  if (input.profile === BENCHMARK_CONTAINER_POLICY_PROFILE) {
    effects.add("sandbox.create");
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

function createDelegateTool(input: {
  readonly runId: string;
  readonly rootScopeId: string;
  readonly rootAgentId: string;
  readonly workspaceRoot: string;
  readonly instruction: string;
  readonly sessionInputs: PiSessionInputs;
  readonly roles: readonly AgentHarnessRole[];
  readonly capabilities: PiCapabilityBindings;
  readonly deniedEffects: ReadonlySet<AgentHarnessCapabilityEffect>;
  readonly policy: AgentHarnessPolicyEvaluator;
  readonly signal?: AbortSignal;
  readonly eventStream: CanonicalEventStream;
  readonly getRootSessionId: () => string | undefined;
  readonly recordPolicyDecisions: (decisions: readonly PolicyDecisionRecord[]) => void;
  readonly factories?: PiRuntimeFactories;
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
          throw new Error("Cannot delegate before the root Pi session is ready.");
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
        const roleRunOptions = {
          cwd: input.workspaceRoot,
          agentDir: input.sessionInputs.agentDir,
          authStorage: input.sessionInputs.authStorage as never,
          modelRegistry: input.sessionInputs.modelRegistry as never,
          model: input.sessionInputs.model as never,
          sessionManager: input.sessionInputs.sessionManager as never,
          settingsManager: input.sessionInputs.settingsManager as never,
          capabilities: rolePolicyResult.capabilities,
          prompt: buildRolePrompt({
            role,
            instruction: params.task,
            parentTask: input.instruction,
          }),
          runId: input.runId,
          rootScopeId: input.rootScopeId,
          rootAgentId: role.id,
          rootSessionId,
          parentSessionId: rootSessionId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          eventStream: input.eventStream,
          onSessionReady: async (context: CapabilityPiSessionEventContext) => {
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
        };
        const roleResult =
          input.factories === undefined
            ? await runCapabilityPiAgentSession(roleRunOptions)
            : await runCapabilityPiAgentSession(roleRunOptions, input.factories);
        const outputText = extractLatestAssistantText(roleResult.session.messages);

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

function createDeadlineSignal(context: AgentHarnessAdapterRunContext): {
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

export function createAgentHarness(
  config: AgentHarnessConfig,
  options: CreateAgentHarnessOptions = {},
): AgentHarness<PiCapabilityBindings, unknown> {
  const adapter = createPiAgentHarnessAdapter(config, options);
  return Object.freeze({
    config,
    adapter,
    run(input: Omit<AgentHarnessRunInput<PiCapabilityBindings>, "harness">) {
      const runId = input.runId ?? randomUUID();
      const runInput = {
        ...input,
        runId,
        harness: config,
      };
      return adapter.run(runInput, createDefaultRunContext(runInput, options));
    },
  });
}

function createDefaultRunContext(
  input: AgentHarnessRunInput<PiCapabilityBindings>,
  options: CreateAgentHarnessOptions,
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
    failureMessage: input.statusMessage,
    errorCategory: input.errorCategory,
  });
}

function createPiAgentHarnessAdapter(
  config: AgentHarnessConfig,
  options: CreateAgentHarnessOptions,
): AgentHarnessAdapter<PiCapabilityBindings, unknown> {
  return Object.freeze({
    id: `${config.id}:pi`,
    kind: "pi",
    async run(
      input: AgentHarnessRunInput<PiCapabilityBindings>,
      context: AgentHarnessAdapterRunContext,
    ): Promise<AgentHarnessRunResult<unknown>> {
      const adapterKind = input.harness.adapter ?? "pi";
      if (adapterKind !== "pi") {
        throw new Error(
          `Harness adapter "${adapterKind}" is configured, but only the pi adapter is implemented in P1.`,
        );
      }

      const runId = input.runId ?? randomUUID();
      const rootScopeId = input.rootScopeId ?? "scope/root";
      const rootAgentId = input.rootAgentId ?? input.harness.primaryAgent ?? "root";
      const profile = input.harness.policyProfile ?? LOCAL_DEV_FULL_POLICY_PROFILE;
      const allowMcp = input.harness.allowMcp ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
      const allowNetwork = input.harness.allowNetwork ?? profile === LOCAL_DEV_FULL_POLICY_PROFILE;
      if (context.signal?.aborted) {
        return failedHarnessResult({
          input,
          runId,
          statusMessage: "Harness run was cancelled before the Pi adapter started.",
          errorCategory: "cancelled",
        });
      }
      if (context.deadline !== undefined && Date.now() >= context.deadline.getTime()) {
        return failedHarnessResult({
          input,
          runId,
          statusMessage: "Harness run deadline elapsed before the Pi adapter started.",
          errorCategory: "deadline_exceeded",
        });
      }
      const runSignal = createDeadlineSignal(context);
      const eventStream = createCanonicalEventStream({});
      const roles = resolveRoles(input.harness);
      const modelId = input.harness.model ?? DEFAULT_OPENAI_CODEX_MODEL;
      const piSessionInputs = options.sessionInputs ?? resolvePiSessionInputs(modelId);
      const baseCapabilities = applyProfilePolicy(input.capabilities ?? {}, profile, allowMcp);
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
              sessionInputs: piSessionInputs,
              roles,
              capabilities: baseCapabilities,
              deniedEffects,
              policy: context.policy,
              ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
              eventStream,
              getRootSessionId: () => rootRuntimeSessionId,
              recordPolicyDecisions: (decisions) => {
                policyDecisions.push(...decisions);
              },
              ...(options.factories === undefined ? {} : { factories: options.factories }),
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

      const result = await runCapabilityPiAgentSession(
        {
          cwd: input.workspaceRoot,
          agentDir: piSessionInputs.agentDir,
          authStorage: piSessionInputs.authStorage as never,
          modelRegistry: piSessionInputs.modelRegistry as never,
          model: piSessionInputs.model as never,
          sessionManager: piSessionInputs.sessionManager as never,
          settingsManager: piSessionInputs.settingsManager as never,
          capabilities: rootPolicyResult.capabilities,
          prompt: buildRootPrompt({
            instruction: input.instruction,
            roles,
            policyProfile: profile,
          }),
          runId,
          rootScopeId,
          rootAgentId,
          ...(runSignal.signal === undefined ? {} : { signal: runSignal.signal }),
          eventStream,
          onSessionReady: async (context) => {
            rootRuntimeSessionId = context.sessionId;
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
        },
        options.factories,
      ).finally(() => {
        runSignal.cleanup();
      });
      const outputText = extractLatestAssistantText(result.session.messages);
      const events = result.events;
      const projections = Object.freeze(events.map(projectEvent));
      const status = result.failureMessage === undefined ? "succeeded" : "failed";
      const finalPolicyDecisions = Object.freeze([...policyDecisions]);
      const summary = jsonObject({
        harnessId: input.harness.id,
        adapter: "pi",
        status,
        outputText,
        eventCount: events.length,
        projectionCount: projections.length,
        policyDecisionCount: finalPolicyDecisions.length,
      });
      const artifacts = await writeHarnessArtifacts({
        artifactStore: context.artifacts,
        eventStream,
        runId,
        scopeId: rootScopeId,
        rootAgentId,
        rootSessionId: result.session.sessionId,
        sessionId: result.session.sessionId,
        events,
        projections,
        policyDecisions: finalPolicyDecisions,
        summary,
      });
      const finalEvents = eventStream.snapshot();
      const finalProjections = Object.freeze(finalEvents.map(projectEvent));
      for (const projection of finalProjections) {
        await context.events.emit(projection);
      }

      return Object.freeze({
        harnessId: input.harness.id,
        adapter: "pi",
        status,
        outputText,
        envelope: result.envelope,
        events: finalEvents,
        projections: finalProjections,
        artifacts,
        policyDecisions: finalPolicyDecisions,
        ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
      });
    },
  });
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
